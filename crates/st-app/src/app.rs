//! The application: session, navigation and message pump.

use std::sync::mpsc::Receiver;
use std::time::Duration;

use egui::{Align, Layout, RichText, Ui};
use st_api::{
    Application, AuthResponse, ClientError, LoginRequest, LoginResponse, Workspace, endpoints,
};

use crate::grid::{GridMsg, GridView};
use crate::labels;
use crate::login::LoginForm;
use crate::net::{Api, Net};
use crate::platform::{Diagnostics, ViewerZone};
use crate::session::{Persisted, STORAGE_KEY, Session, default_api_base, unix_now};
use crate::sidebar::{self, SidebarAction};

/// The state of data fetched from the API.
pub enum Remote<T> {
    /// Not requested yet, or to be requested again.
    Idle,
    Loading,
    Ready(T),
    Failed(String),
}

/// An answer of the API, posted to the app's inbox by [`Net`].
pub enum Msg {
    Login(Result<LoginResponse, ClientError>),
    Refresh(Result<AuthResponse, ClientError>),
    Workspaces(Result<Vec<Workspace>, ClientError>),
    Applications(Result<Vec<Application>, ClientError>),
    Grid {
        generation: u64,
        msg: GridMsg,
    },
    /// An answer nobody waits for (logout).
    Ignored,
}

/// When to refresh the access token.
#[derive(Default)]
struct Refresh {
    in_flight: bool,
    /// Refresh now even if the token is not due, because the server refused it.
    forced: bool,
    /// After a network failure, wait until then (Unix seconds) before retrying.
    retry_at: u64,
}

pub struct SupertaskApp {
    net: Net,
    inbox: Receiver<Msg>,
    persisted: Persisted,
    /// The persisted state changed and must be written before the next frame.
    dirty: bool,
    login: LoginForm,
    refresh: Refresh,
    workspaces: Remote<Vec<Workspace>>,
    applications: Remote<Vec<Application>>,
    grid: Option<GridView>,
    zone: ViewerZone,
    diagnostics: Diagnostics,
    frame_timer: FrameTimer,
}

/// The CPU time of the app's UI pass (layout and painting commands, without
/// the GPU), the slowest of the last frames: a measure of how heavy the grid
/// is that does not depend on the machine's graphics.
#[derive(Default)]
struct FrameTimer {
    recent_ms: std::collections::VecDeque<f32>,
}

impl FrameTimer {
    const WINDOW: usize = 120;

    fn record(&mut self, milliseconds: f32) {
        if self.recent_ms.len() == Self::WINDOW {
            self.recent_ms.pop_front();
        }
        self.recent_ms.push_back(milliseconds);
    }

    fn max_ms(&self) -> f32 {
        self.recent_ms.iter().copied().fold(0.0, f32::max)
    }
}

impl SupertaskApp {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        cc.egui_ctx.set_theme(egui::Theme::Light);
        let mut persisted: Persisted = cc
            .storage
            .and_then(|storage| eframe::get_value(storage, STORAGE_KEY))
            .unwrap_or_default();
        let api_base = persisted.api_base.clone().unwrap_or_else(default_api_base);
        let (net, inbox) = Net::new(cc.egui_ctx.clone(), api_base.clone());
        let mut login = LoginForm {
            email: persisted.last_email.clone(),
            api_base,
            ..Default::default()
        };
        if persisted
            .session
            .as_ref()
            .is_some_and(|session| !session.can_refresh(unix_now()))
        {
            persisted.session = None;
            login.error = Some("Votre session a expiré, reconnectez-vous.".to_owned());
        }
        Self {
            net,
            inbox,
            persisted,
            dirty: false,
            login,
            refresh: Refresh::default(),
            workspaces: Remote::Idle,
            applications: Remote::Idle,
            grid: None,
            zone: ViewerZone,
            diagnostics: Diagnostics::default(),
            frame_timer: FrameTimer::default(),
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Login(result) => self.on_login(result),
            Msg::Refresh(result) => self.on_refresh(result),
            Msg::Workspaces(result) => self.workspaces = self.remote(result),
            Msg::Applications(result) => {
                self.applications = self.remote(result);
                self.reopen_last_table();
            }
            Msg::Grid { generation, msg } => {
                if let Some(grid) = self
                    .grid
                    .as_mut()
                    .filter(|grid| grid.generation == generation)
                {
                    grid.handle(msg);
                    if std::mem::take(&mut grid.needs_reauth) {
                        self.refresh.forced = true;
                    }
                }
            }
            Msg::Ignored => {}
        }
    }

    /// Turns an answer into a [`Remote`]; a refused token leaves it idle so
    /// that it is requested again once the token is refreshed.
    fn remote<T>(&mut self, result: Result<T, ClientError>) -> Remote<T> {
        match result {
            Ok(value) => Remote::Ready(value),
            Err(error) if error.is_unauthenticated() => {
                self.refresh.forced = true;
                Remote::Idle
            }
            Err(error) => Remote::Failed(labels::client_error(&error)),
        }
    }

    fn on_login(&mut self, result: Result<LoginResponse, ClientError>) {
        self.login.pending = false;
        match result {
            Ok(LoginResponse::Session(auth)) => {
                self.login.password.clear();
                self.login.error = None;
                self.persisted.last_email = self.login.email.trim().to_owned();
                self.persisted.session = Some(Session::from_auth(*auth));
                self.refresh = Refresh::default();
                self.dirty = true;
            }
            Ok(LoginResponse::TwoFactor { .. }) => {
                self.login.error = Some(
                    "Ce compte utilise la double authentification, pas encore disponible dans l'app Rust.".to_owned(),
                );
            }
            Err(error) => self.login.error = Some(labels::client_error(&error)),
        }
    }

    fn on_refresh(&mut self, result: Result<AuthResponse, ClientError>) {
        self.refresh.in_flight = false;
        match result {
            Ok(auth) => {
                if let Some(session) = self.persisted.session.as_mut() {
                    session.apply_refresh(auth);
                    self.dirty = true;
                }
            }
            Err(ClientError::Api(error)) if error.status == 401 || error.status == 400 => {
                self.logout(Some("Votre session a expiré, reconnectez-vous.".to_owned()));
            }
            Err(error) => {
                log::warn!("token refresh failed: {error}");
                self.refresh.retry_at = unix_now() + 15;
            }
        }
    }

    /// Refreshes the access token before it expires, and wakes the app up in
    /// time to do so even when nothing else happens.
    fn maintain_session(&mut self, ctx: &egui::Context) {
        let Some(session) = &self.persisted.session else {
            return;
        };
        if self.refresh.in_flight {
            return;
        }
        let now = unix_now();
        let due = if self.refresh.forced {
            now
        } else {
            session.refresh_due_at()
        };
        let due = due.max(self.refresh.retry_at);
        if now < due {
            ctx.request_repaint_after(Duration::from_secs(due - now));
            return;
        }
        self.refresh.in_flight = true;
        self.refresh.forced = false;
        self.net.send(
            endpoints::refresh(&session.refresh_token),
            None,
            Msg::Refresh,
        );
    }

    fn logout(&mut self, reason: Option<String>) {
        if let Some(session) = self.persisted.session.take() {
            self.net
                .send(endpoints::logout(&session.refresh_token), None, |_| {
                    Msg::Ignored
                });
        }
        self.inbox = self.net.reset_inbox();
        self.refresh = Refresh::default();
        self.workspaces = Remote::Idle;
        self.applications = Remote::Idle;
        self.grid = None;
        self.login.error = reason;
        self.login.pending = false;
        self.dirty = true;
    }

    fn open_table(&mut self, id: u64, name: String) {
        self.grid = Some(GridView::new(id, name));
        self.persisted.selected_table = Some(id);
        self.dirty = true;
    }

    fn reopen_last_table(&mut self) {
        if self.grid.is_some() {
            return;
        }
        let Some(id) = self.persisted.selected_table else {
            return;
        };
        if let Some(name) = sidebar::table_name(&self.applications, id) {
            self.grid = Some(GridView::new(id, name));
        }
    }

    fn submit_login(&mut self) {
        let api_base = self.login.api_base.trim().trim_end_matches('/').to_owned();
        self.net.set_base_url(api_base.clone());
        self.persisted.api_base = Some(api_base);
        self.login.pending = true;
        let request = LoginRequest {
            email: self.login.email.trim().to_owned(),
            password: self.login.password.clone(),
        };
        self.net.send(endpoints::login(&request), None, Msg::Login);
    }

    fn main_ui(&mut self, ui: &mut Ui) {
        let api = api(&self.net, self.persisted.session.as_ref(), &self.refresh);
        if let Some(api) = api {
            if matches!(self.workspaces, Remote::Idle) {
                self.workspaces = Remote::Loading;
                api.send(endpoints::workspaces(), Msg::Workspaces);
            }
            if matches!(self.applications, Remote::Idle) {
                self.applications = Remote::Loading;
                api.send(endpoints::applications(), Msg::Applications);
            }
        }

        let mut logout = false;
        egui::Panel::top("top-bar").show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(RichText::new("Supertask").size(18.0).strong());
                if let Some(grid) = &self.grid {
                    ui.weak("›");
                    ui.label(&grid.table_name);
                }
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    logout = ui.button("Se déconnecter").clicked();
                    if let Some(session) = &self.persisted.session {
                        ui.label(RichText::new(session.user.display_name()).strong())
                            .on_hover_text(&session.user.email);
                    }
                    if self.refresh.in_flight {
                        ui.spinner().on_hover_text("Renouvellement de la session…");
                    }
                });
            });
        });

        let mut action = None;
        egui::Panel::left("sidebar")
            .resizable(true)
            .default_size(250.0)
            .size_range(180.0..=420.0)
            .show(ui, |ui| {
                egui::ScrollArea::vertical()
                    .auto_shrink(false)
                    .show(ui, |ui| {
                        ui.add_space(4.0);
                        let selected = self.grid.as_ref().map(|grid| grid.table_id);
                        action = sidebar::show(ui, &self.workspaces, &self.applications, selected);
                    });
            });

        egui::CentralPanel::default_margins().show(ui, |ui| match self.grid.as_mut() {
            Some(grid) => grid.ui(ui, api, &self.zone),
            None => {
                ui.centered_and_justified(|ui| {
                    ui.weak("Choisissez une table dans la barre latérale.")
                });
            }
        });

        match action {
            Some(SidebarAction::OpenTable { id, name }) => self.open_table(id, name),
            Some(SidebarAction::Retry) => {
                self.workspaces = Remote::Idle;
                self.applications = Remote::Idle;
            }
            None => {}
        }
        if logout {
            self.logout(None);
        }
    }

    fn publish_diagnostics(&mut self) {
        let stats = self
            .grid
            .as_ref()
            .map(|grid| grid.stats)
            .unwrap_or_default();
        self.diagnostics.publish(
            "table-id",
            self.grid.as_ref().map_or(0, |grid| grid.table_id),
        );
        self.diagnostics.publish("rows-total", stats.total);
        self.diagnostics.publish("rows-loaded", stats.loaded);
        self.diagnostics.publish("rows-laid-out", stats.laid_out);
        self.diagnostics
            .publish("first-visible-row", stats.first_visible);
        self.diagnostics
            .publish("pages-in-flight", stats.pages_in_flight);
        self.diagnostics
            .publish("signed-in", self.persisted.session.is_some());
        self.diagnostics
            .publish("ui-ms-max", format!("{:.1}", self.frame_timer.max_ms()));
    }
}

/// The API handle for authenticated calls, when they can be made: signed in
/// and not in the middle of a token refresh.
fn api<'a>(net: &'a Net, session: Option<&'a Session>, refresh: &Refresh) -> Option<Api<'a>> {
    let session = session?;
    (!refresh.in_flight && !refresh.forced).then_some(Api {
        net,
        token: &session.access_token,
    })
}

impl eframe::App for SupertaskApp {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(msg) = self.inbox.try_recv() {
            self.handle(msg);
        }
        self.maintain_session(ctx);
    }

    fn ui(&mut self, ui: &mut Ui, frame: &mut eframe::Frame) {
        let started = web_time::Instant::now();
        if self.persisted.session.is_some() {
            self.main_ui(ui);
        } else {
            let mut submit = false;
            egui::CentralPanel::default_margins().show(ui, |ui| submit = self.login.show(ui));
            if submit {
                self.submit_login();
            }
        }
        self.frame_timer
            .record(started.elapsed().as_secs_f32() * 1000.0);
        self.publish_diagnostics();
        if std::mem::take(&mut self.dirty)
            && let Some(storage) = frame.storage_mut()
        {
            eframe::set_value(storage, STORAGE_KEY, &self.persisted);
            storage.flush();
        }
    }

    fn save(&mut self, storage: &mut dyn eframe::Storage) {
        eframe::set_value(storage, STORAGE_KEY, &self.persisted);
    }
}
