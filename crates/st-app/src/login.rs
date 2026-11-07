//! The login screen.

use egui::{Align, Frame, Key, Layout, Margin, RichText, TextEdit, Ui};

/// What the user typed on the login screen.
#[derive(Default)]
pub struct LoginForm {
    pub email: String,
    pub password: String,
    /// The API origin; empty means the page's own origin (web only).
    pub api_base: String,
    pub pending: bool,
    pub error: Option<String>,
}

impl LoginForm {
    /// Draws the form; returns `true` when the user submits it.
    pub fn show(&mut self, ui: &mut Ui) -> bool {
        let mut submit = false;
        ui.vertical_centered(|ui| {
            ui.add_space((ui.available_height() * 0.15).min(120.0));
            ui.label(RichText::new("Supertask").size(30.0).strong());
            ui.weak("Connectez-vous à votre compte");
            ui.add_space(16.0);
            Frame::group(ui.style())
                .inner_margin(Margin::same(20))
                .show(ui, |ui| {
                    ui.set_width(320.0);
                    ui.with_layout(Layout::top_down(Align::Min), |ui| submit = self.fields(ui));
                });
        });
        submit
    }

    fn fields(&mut self, ui: &mut Ui) -> bool {
        let enabled = !self.pending;
        ui.label("Adresse e-mail");
        let email = ui.add_enabled(
            enabled,
            TextEdit::singleline(&mut self.email)
                .hint_text("vous@exemple.fr")
                .desired_width(f32::INFINITY),
        );
        ui.add_space(8.0);
        ui.label("Mot de passe");
        let password = ui.add_enabled(
            enabled,
            TextEdit::singleline(&mut self.password)
                .password(true)
                .desired_width(f32::INFINITY),
        );
        if self.email.is_empty() && !email.has_focus() && !password.has_focus() && enabled {
            email.request_focus();
        }
        let pressed_enter = (email.lost_focus() || password.lost_focus())
            && ui.input(|input| input.key_pressed(Key::Enter));

        ui.add_space(8.0);
        egui::CollapsingHeader::new(RichText::new("Serveur").weak()).id_salt("login-server").show(ui, |ui| {
            ui.add_enabled(
                enabled,
                TextEdit::singleline(&mut self.api_base)
                    .hint_text("même origine que la page")
                    .desired_width(f32::INFINITY),
            );
            ui.weak("Adresse de l'API, par exemple http://127.0.0.1:8811. Vide : l'origine de la page.");
        });

        if let Some(error) = &self.error {
            ui.add_space(8.0);
            ui.colored_label(ui.visuals().error_fg_color, error);
        }
        ui.add_space(12.0);
        let clicked = ui
            .add_enabled_ui(enabled, |ui| {
                ui.horizontal(|ui| {
                    let clicked = ui.button(RichText::new("Se connecter").strong()).clicked();
                    if self.pending {
                        ui.spinner();
                    }
                    clicked
                })
                .inner
            })
            .inner;

        if !(clicked || pressed_enter) || self.pending {
            return false;
        }
        if self.email.trim().is_empty() || self.password.is_empty() {
            self.error = Some("Saisissez votre adresse e-mail et votre mot de passe.".to_owned());
            return false;
        }
        self.error = None;
        true
    }
}
