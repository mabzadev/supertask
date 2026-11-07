/**
 * Resets the LOCAL development environment and fills it with test data.
 *
 *   npm run dev:reset-local
 *
 * - Wipes the wrangler dev state (.wrangler/state: D1, KV, Durable Objects) and
 *   applies every migration to a fresh local database.
 * - Copies the administrator account from production (same e-mail and password
 *   hash, nothing else is read from production).
 * - Creates test users, several workspaces and every application, field and
 *   view type through the local API, as the app itself would.
 *
 * It only ever talks to the local API (refuses any other host) and needs the
 * systemd user service `supertask-dev-api` that runs `wrangler dev`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { signAccessToken } from "../src/middleware/auth";
import { hashPassword } from "../src/services/user";

const API = process.env.LOCAL_API_URL || "http://127.0.0.1:8811";
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API)) {
  throw new Error(`Refusing to reset a non-local API: ${API}`);
}
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "mabzadev@gmail.com").toLowerCase();
export const TEST_PASSWORD = "Supertask-test-2026";
const STATE_DIRS = [".wrangler/state/v3/d1", ".wrangler/state/v3/kv", ".wrangler/state/v3/do"];

// ── Shell helpers ────────────────────────────────────────────────────────────

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(command, args, { encoding: "utf8", env: { ...env, CI: "true" }, maxBuffer: 64 * 1024 * 1024 });
}

function cloudflareEnv(): NodeJS.ProcessEnv {
  const file = `${process.env.HOME}/.config/supertask/cloudflare.env`;
  const values = Object.fromEntries(readFileSync(file, "utf8").split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).replace(/^export\s+/, ""), line.slice(index + 1).replace(/^["']|["']$/g, "")];
    }));
  return { ...process.env, ...values };
}

function d1Json(where: "--local" | "--remote", sql: string, env?: NodeJS.ProcessEnv): any[] {
  const out = run("npx", ["wrangler", "d1", "execute", "supertask-db", where, "--json", "--command", sql], env);
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

function d1LocalFile(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "supertask-seed-"));
  const file = join(dir, "seed.sql");
  writeFileSync(file, sql);
  run("npx", ["wrangler", "d1", "execute", "supertask-db", "--local", "--file", file]);
  rmSync(dir, { recursive: true, force: true });
}

const quote = (value: unknown) => value === null || value === undefined ? "NULL" : `'${String(value).replace(/'/g, "''")}'`;

async function waitForApi() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${API}/api/_health/`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The local API did not start.");
}

// ── API client ───────────────────────────────────────────────────────────────

type Session = { id: number; email: string; token: string };

async function api(session: Session, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}/api${path}`, {
    method,
    headers: { authorization: `JWT ${session.token}`, ...(body instanceof FormData ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// ── Deterministic test values ────────────────────────────────────────────────

let seed = 20261107;
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
const pickSome = <T>(items: T[], max = 3): T[] => items.filter(() => random() < max / items.length).slice(0, max);
const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1));
function day(offset: number) {
  const date = new Date(Date.UTC(2026, 10, 7) + offset * 86400000);
  return date.toISOString().slice(0, 10);
}
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const commentMessage = (text: string) => ({ type: "doc", content: [paragraph(text)] });

/** A solid-colour PNG, so file fields and galleries have images to show. */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set([r, g, b], y * (1 + width * 3) + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const png = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

// ── Seeding steps ────────────────────────────────────────────────────────────

type Field = { id: number; name: string; type: string; select_options?: Array<{ id: number; value: string }> };

class TableBuilder {
  fields = new Map<string, Field>();
  constructor(readonly session: Session, readonly id: number) {}

  async load() {
    for (const field of await api(this.session, "GET", `/database/fields/table/${this.id}/`)) this.fields.set(field.name, field);
    return this;
  }

  async renamePrimary(name: string) {
    const primary = [...this.fields.values()][0];
    this.fields.delete(primary.name);
    this.fields.set(name, await api(this.session, "PATCH", `/database/fields/${primary.id}/`, { name }));
  }

  async field(name: string, type: string, options: Record<string, unknown> = {}): Promise<Field> {
    const field = await api(this.session, "POST", `/database/fields/table/${this.id}/`, { name, type, ...options });
    this.fields.set(name, field);
    return field;
  }

  key(name: string) {
    const field = this.fields.get(name);
    if (!field) throw new Error(`Unknown field ${name} on table ${this.id}`);
    return `field_${field.id}`;
  }

  option(fieldName: string, value: string) {
    const option = this.fields.get(fieldName)?.select_options?.find((item) => item.value === value);
    if (!option) throw new Error(`Unknown option ${value} of ${fieldName}`);
    return option.id;
  }

  async rows(items: Array<Record<string, unknown>>): Promise<Array<{ id: number }>> {
    const created: Array<{ id: number }> = [];
    for (let offset = 0; offset < items.length; offset += 100) {
      const body = { items: items.slice(offset, offset + 100).map((item) => Object.fromEntries(
        Object.entries(item).map(([name, value]) => [this.key(name), value])
      )) };
      created.push(...(await api(this.session, "POST", `/database/rows/table/${this.id}/batch/`, body)).items);
    }
    return created;
  }
}

/** A table of the database; the first one reuses the table every new database starts with. */
const usedDefaultTable = new Set<number>();
async function createTable(session: Session, databaseId: number, name: string): Promise<TableBuilder> {
  let id: number;
  if (!usedDefaultTable.has(databaseId)) {
    usedDefaultTable.add(databaseId);
    const [first] = await api(session, "GET", `/database/tables/database/${databaseId}/`);
    id = first.id;
    await api(session, "PATCH", `/database/tables/${id}/`, { name });
  } else {
    id = (await api(session, "POST", `/database/tables/database/${databaseId}/`, { name })).id;
  }
  return new TableBuilder(session, id).load();
}

const SELECT = (values: string[], colors = ["blue", "green", "orange", "red", "dark-blue", "purple", "yellow"]) => ({
  select_options: values.map((value, index) => ({ value, color: colors[index % colors.length] })),
});

async function createViews(session: Session, table: TableBuilder, config: {
  status: string; start?: string; end?: string; cover?: string; formFields: string[];
}) {
  const views = await api(session, "GET", `/database/views/table/${table.id}/`);
  await api(session, "PATCH", `/database/views/${views[0].id}/`, { name: "Toutes les lignes" });
  const statusField = table.fields.get(config.status)!;

  const active = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Filtrée et triée", type: "grid" });
  await api(session, "POST", `/database/views/${active.id}/filters/`, { field: statusField.id, type: "single_select_not_equal", value: String(statusField.select_options![statusField.select_options!.length - 1].id) });
  if (config.end) await api(session, "POST", `/database/views/${active.id}/sortings/`, { field: table.fields.get(config.end)!.id, order: "ASC" });

  const grouped = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Groupée", type: "grid" });
  await api(session, "POST", `/database/views/${grouped.id}/group_bys/`, { field: statusField.id, order: "ASC" });
  await api(session, "POST", `/database/views/${grouped.id}/decorations/`, {
    type: "left_border_color",
    value_provider_type: "single_select_color",
    value_provider_conf: { field_id: statusField.id },
  });

  const kanban = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Kanban", type: "kanban" });
  await api(session, "PATCH", `/database/views/${kanban.id}/`, { single_select_field: statusField.id });
  if (config.end) {
    const calendar = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Calendrier", type: "calendar" });
    await api(session, "PATCH", `/database/views/${calendar.id}/`, { date_field: table.fields.get(config.end)!.id });
  }
  if (config.start && config.end) {
    const timeline = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Frise", type: "timeline" });
    await api(session, "PATCH", `/database/views/${timeline.id}/`, {
      start_date_field: table.fields.get(config.start)!.id,
      end_date_field: table.fields.get(config.end)!.id,
    });
  }
  const gallery = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Galerie", type: "gallery" });
  if (config.cover) await api(session, "PATCH", `/database/views/${gallery.id}/`, { card_cover_image_field: table.fields.get(config.cover)!.id });
  const form = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Formulaire", type: "form" });
  await api(session, "PATCH", `/database/views/${form.id}/`, { title: "Nouvelle demande", description: "Formulaire de test." });
  await api(session, "PATCH", `/database/views/${form.id}/field-options/`, {
    field_options: Object.fromEntries(config.formFields.map((name, index) => [table.fields.get(name)!.id, { enabled: true, required: index === 0, order: index }])),
  });
  const survey = await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Questionnaire", type: "survey" });
  await api(session, "PATCH", `/database/views/${survey.id}/field-options/`, {
    field_options: Object.fromEntries(config.formFields.map((name, index) => [table.fields.get(name)!.id, { enabled: true, order: index }])),
  });
  await api(session, "POST", `/database/views/table/${table.id}/`, { name: "Personnelle", type: "grid", ownership_type: "personal" });
}

async function uploadImages(session: Session) {
  const colors: Array<[string, [number, number, number]]> = [
    ["violet", [124, 58, 237]], ["bleu", [37, 99, 235]], ["vert", [22, 163, 74]],
    ["orange", [234, 88, 12]], ["rose", [219, 39, 119]], ["gris", [82, 82, 91]],
  ];
  const uploaded = [];
  for (const [name, color] of colors) {
    const form = new FormData();
    form.append("file", new Blob([solidPng(320, 200, color)], { type: "image/png" }), `${name}.png`);
    uploaded.push(await api(session, "POST", "/user-files/upload-file/", form));
  }
  return uploaded.map((file) => [{ name: file.name, visible_name: file.original_name }]);
}

async function seedAgency(admin: Session, users: Record<string, Session>, workspaceId: number, images: unknown[][]) {
  const database = await api(admin, "POST", `/applications/workspace/${workspaceId}/`, { name: "CRM", type: "database" });

  const clients = await createTable(admin, database.id, "Clients");
  await clients.renamePrimary("Nom");
  await clients.field("Secteur", "single_select", SELECT(["Tech", "Santé", "Commerce", "Finance", "Éducation"]));
  await clients.field("Site web", "url");
  await clients.field("E-mail", "email");
  await clients.field("Téléphone", "phone_number");
  await clients.field("Ville", "text");
  await clients.field("Client depuis", "date", { date_format: "EU", date_include_time: false });
  await clients.field("Satisfaction", "rating", { max_value: 5, color: "dark-orange", style: "star" });
  await clients.field("Actif", "boolean");
  await clients.field("Logo", "file");
  await clients.field("Notes", "long_text");
  await clients.field("Référence", "uuid");
  await clients.field("N°", "autonumber");

  const cities = ["Paris", "Lyon", "Genève", "Lausanne", "Bordeaux", "Lille", "Nantes", "Bruxelles"];
  const companies = ["Atelier Lumen", "Boréal Santé", "Cobalt Retail", "Delta Finance", "École Horizon", "Fjord Digital", "Galilée Labs", "Hélios Énergie", "Iris Mobilité", "Jade Conseil", "Kairos Médias", "Lynx Logistique", "Mistral Foods", "Nuage Telecom", "Orbe Assurances", "Pixel & Co", "Quartz Immobilier", "Rivage Hôtels", "Saphir Biotech", "Terra Agri"];
  const clientRows = await clients.rows(companies.map((name, index) => ({
    Nom: name,
    Secteur: clients.option("Secteur", pick(["Tech", "Santé", "Commerce", "Finance", "Éducation"])),
    "Site web": `https://${name.toLowerCase().normalize("NFD").replace(/[^a-z]+/g, "")}.example.com`,
    "E-mail": `contact@${name.toLowerCase().normalize("NFD").replace(/[^a-z]+/g, "")}.example.com`,
    Téléphone: `+41 22 ${between(100, 999)} ${between(10, 99)} ${between(10, 99)}`,
    Ville: pick(cities),
    "Client depuis": day(-between(30, 1200)),
    Satisfaction: between(2, 5),
    Actif: random() > 0.2,
    Logo: images[index % images.length],
    Notes: `Client ${name}. Interlocuteur principal joignable le matin.\nDernier point : ${day(-between(1, 40))}.`,
  })));

  const projects = await createTable(admin, database.id, "Projets");
  await projects.renamePrimary("Nom");
  const clientLink = await projects.field("Client", "link_row", { link_row_table_id: clients.id, has_related_field: true });
  await projects.field("Statut", "single_select", SELECT(["À faire", "En cours", "En revue", "Terminé", "Bloqué"], ["light-gray", "blue", "orange", "green", "red"]));
  await projects.field("Priorité", "single_select", SELECT(["Basse", "Moyenne", "Haute", "Critique"]));
  await projects.field("Étiquettes", "multiple_select", SELECT(["Design", "Développement", "SEO", "Contenu", "Data", "Mobile"]));
  await projects.field("Responsables", "multiple_collaborators", { notify_user_when_added: false });
  await projects.field("Début", "date", { date_format: "EU", date_include_time: false });
  await projects.field("Échéance", "date", { date_format: "EU", date_include_time: false });
  await projects.field("Prochain point", "date", { date_format: "EU", date_include_time: true, date_time_format: "24" });
  await projects.field("Budget", "number", { number_decimal_places: 2, number_negative: false, number_prefix: "", number_suffix: " €" });
  await projects.field("Avancement", "number", { number_decimal_places: 0, number_suffix: " %" });
  await projects.field("Temps passé", "duration", { duration_format: "h:mm" });
  await projects.field("Livré", "boolean");
  await projects.field("Brief", "long_text");
  await projects.field("Visuels", "file");
  await projects.field("Code d'accès", "password");
  await projects.field("Créé le", "created_on", { date_format: "EU", date_include_time: true, date_time_format: "24" });
  await projects.field("Modifié le", "last_modified", { date_format: "EU", date_include_time: true, date_time_format: "24" });
  await projects.field("Créé par", "created_by");
  await projects.field("Modifié par", "last_modified_by");
  await projects.field("Jours restants", "formula", { formula: "date_diff('dd', today(), field('Échéance'))" });
  await projects.field("Résumé", "formula", { formula: "concat(field('Nom'), ' — ', totext(field('Avancement')), ' %')" });
  const sectorField = clients.fields.get("Secteur")!;
  await projects.field("Secteur du client", "lookup", { through_field_id: clientLink.id, target_field_id: sectorField.id });
  await projects.field("Résumé IA", "ai", {
    ai_generative_ai_type: "ollama",
    ai_generative_ai_model: "llama3.1",
    ai_output_type: "text",
    ai_prompt: "concat('Résume ce brief en une phrase : ', field('Brief'))",
  });

  await clients.load();
  const reverseLink = [...clients.fields.values()].find((field) => field.type === "link_row")!;
  await clients.field("Nombre de projets", "count", { through_field_id: reverseLink.id });
  await clients.field("Budget total", "rollup", { through_field_id: reverseLink.id, target_field_id: projects.fields.get("Budget")!.id, rollup_function: "sum" });

  const team = [admin, users.alice, users.bruno, users.chloe];
  const projectNames = ["Refonte du site", "Campagne de printemps", "Application mobile", "Audit SEO", "Charte graphique", "Newsletter mensuelle", "Tableau de bord ventes", "Migration CRM", "Vidéo de marque", "Salon professionnel", "Programme fidélité", "Étude de marché", "Landing page produit", "Portail partenaires", "Podcast interne"];
  const statuses = ["À faire", "En cours", "En revue", "Terminé", "Bloqué"];
  const projectItems = Array.from({ length: 45 }, (_, index) => {
    const start = between(-60, 40);
    const status = pick(statuses);
    return {
      Nom: `${projectNames[index % projectNames.length]}${index >= projectNames.length ? ` ${Math.floor(index / projectNames.length) + 1}` : ""}`,
      Client: [clientRows[index % clientRows.length].id],
      Statut: projects.option("Statut", status),
      Priorité: projects.option("Priorité", pick(["Basse", "Moyenne", "Haute", "Critique"])),
      Étiquettes: pickSome(["Design", "Développement", "SEO", "Contenu", "Data", "Mobile"]).map((value) => projects.option("Étiquettes", value)),
      Responsables: pickSome(team, 2).map((member) => ({ id: member.id })),
      Début: day(start),
      Échéance: day(start + between(5, 60)),
      "Prochain point": `${day(start + between(1, 10))}T${String(between(8, 17)).padStart(2, "0")}:30:00Z`,
      Budget: between(20, 400) * 100,
      Avancement: status === "Terminé" ? 100 : between(0, 95),
      "Temps passé": between(1, 120) * 1800,
      Livré: status === "Terminé",
      Brief: "Objectifs, livrables et contraintes du projet.\n- Cible : clients existants\n- Ton : chaleureux et direct",
      Visuels: random() > 0.5 ? images[index % images.length] : [],
      "Code d'accès": "acces-client",
    };
  });
  const projectRows = await projects.rows(projectItems);
  await createViews(admin, projects, { status: "Statut", start: "Début", end: "Échéance", cover: "Visuels", formFields: ["Nom", "Client", "Priorité", "Brief", "Échéance"] });
  await createViews(admin, clients, { status: "Secteur", cover: "Logo", formFields: ["Nom", "E-mail", "Téléphone", "Ville"] });

  const commenters = [users.alice, users.bruno, users.chloe, users.david];
  const remarks = ["Le client valide la maquette.", "On décale la livraison d'une semaine.", "Budget confirmé par le client.", "Je m'occupe de la relecture.", "Attention au délai de traduction.", "Point fait ce matin, tout est clair."];
  for (const row of projectRows.slice(0, 12)) {
    for (let count = between(1, 3); count > 0; count -= 1) {
      await api(pick(commenters), "POST", `/row_comments/${projects.id}/${row.id}/`, { message: commentMessage(pick(remarks)) });
    }
  }
  // Edits by others, so the history and "modified by" fields have variety.
  for (const row of projectRows.slice(0, 8)) {
    await api(pick([users.alice, users.chloe]), "PATCH", `/database/rows/table/${projects.id}/${row.id}/`, { [projects.key("Avancement")]: between(10, 90) });
  }

  const invoices = await createTable(admin, database.id, "Factures");
  await invoices.renamePrimary("Numéro");
  await invoices.field("Client", "link_row", { link_row_table_id: clients.id, has_related_field: false });
  await invoices.field("Montant HT", "number", { number_decimal_places: 2, number_suffix: " €" });
  await invoices.field("TVA", "formula", { formula: "round(field('Montant HT') * 0.2, 2)" });
  await invoices.field("Émise le", "date", { date_format: "EU" });
  await invoices.field("Payée", "boolean");
  await invoices.field("Statut", "single_select", SELECT(["Brouillon", "Envoyée", "Payée", "En retard"], ["light-gray", "blue", "green", "red"]));
  await invoices.rows(Array.from({ length: 30 }, (_, index) => {
    const status = pick(["Brouillon", "Envoyée", "Payée", "En retard"]);
    return {
      Numéro: `F-2026-${String(index + 1).padStart(3, "0")}`,
      Client: [pick(clientRows).id],
      "Montant HT": between(5, 120) * 100,
      "Émise le": day(-between(0, 180)),
      Payée: status === "Payée",
      Statut: invoices.option("Statut", status),
    };
  }));

  await seedDashboard(admin, workspaceId, "Pilotage", projects);
  await seedDocument(admin, workspaceId, "Wiki de l'agence", [
    ["Bienvenue", "Tout ce qu'il faut savoir pour démarrer à l'agence."],
    ["Process d'onboarding client", "Les étapes, de la signature au premier livrable."],
    ["Modèles d'e-mails", "Relances, comptes rendus et propositions."],
  ]);
  await seedWhiteboard(admin, workspaceId, "Ateliers", [["Campagne de printemps", "brainstorming"], ["Parcours client", "flowchart"]]);
  await seedBuilder(admin, workspaceId, "Portail client");
  await seedAutomation(admin, workspaceId, "Automatisations CRM", clients, projects);
}

async function seedDashboard(session: Session, workspaceId: number, name: string, table: TableBuilder) {
  const dashboard = await api(session, "POST", `/applications/workspace/${workspaceId}/`, { name, type: "dashboard" });
  const count = await api(session, "POST", `/dashboard/${dashboard.id}/widgets/`, { type: "summary", title: "Lignes", description: `Nombre de lignes de ${name}` });
  await api(session, "PATCH", `/dashboard/data-sources/${count.data_source_id}/`, { table_id: table.id, field_id: [...table.fields.values()][0].id, aggregation_type: "count" });
  const numberField = [...table.fields.values()].find((field) => field.type === "number");
  if (numberField) {
    const sum = await api(session, "POST", `/dashboard/${dashboard.id}/widgets/`, { type: "summary", title: `Total ${numberField.name}` });
    await api(session, "PATCH", `/dashboard/data-sources/${sum.data_source_id}/`, { table_id: table.id, field_id: numberField.id, aggregation_type: "sum" });
  }
  const statusField = [...table.fields.values()].find((field) => field.type === "single_select");
  if (statusField) {
    const chart = await api(session, "POST", `/dashboard/${dashboard.id}/widgets/`, { type: "chart", title: `Par ${statusField.name}`, default_series_chart_type: "BAR" });
    await api(session, "PATCH", `/dashboard/data-sources/${chart.data_source_id}/`, {
      table_id: table.id,
      aggregation_series: [{ field_id: [...table.fields.values()][0].id, aggregation_type: "count" }],
      aggregation_group_bys: [{ field_id: statusField.id }],
    });
    const pie = await api(session, "POST", `/dashboard/${dashboard.id}/widgets/`, { type: "pie_chart", title: `Répartition par ${statusField.name}`, default_series_chart_type: "PIE" });
    await api(session, "PATCH", `/dashboard/data-sources/${pie.data_source_id}/`, {
      table_id: table.id,
      aggregation_series: [{ field_id: [...table.fields.values()][0].id, aggregation_type: "count" }],
      aggregation_group_bys: [{ field_id: statusField.id }],
    });
  }
}

async function seedDocument(session: Session, workspaceId: number, name: string, pages: Array<[string, string]>) {
  const document = await api(session, "POST", `/applications/workspace/${workspaceId}/`, { name, type: "document" });
  let parentId: number | null = null;
  for (const [index, [title, intro]] of pages.entries()) {
    const content = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: title }] },
        paragraph(intro),
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Points clés" }] },
        { type: "bulletList", content: ["Préparer", "Valider", "Livrer"].map((text) => ({ type: "listItem", content: [paragraph(text)] })) },
        { type: "taskList", content: ["Lire la page", "Poser ses questions"].map((text, item) => ({ type: "taskItem", attrs: { checked: item === 0 }, content: [paragraph(text)] })) },
      ],
    };
    const page = await api(session, "POST", `/document/${document.id}/pages/`, {
      title,
      icon: ["📘", "🧭", "✉️", "🧩"][index % 4],
      content,
      parent_id: index === pages.length - 1 ? parentId : null,
    });
    if (index === 0) parentId = page.id;
  }
}

async function seedWhiteboard(session: Session, workspaceId: number, name: string, canvases: Array<[string, string]>) {
  const whiteboard = await api(session, "POST", `/applications/workspace/${workspaceId}/`, { name, type: "whiteboard" });
  for (const [canvas, template] of canvases) {
    await api(session, "POST", `/whiteboards/${whiteboard.id}/canvases/`, { name: canvas, template });
  }
}

async function seedBuilder(session: Session, workspaceId: number, name: string) {
  const builder = await api(session, "POST", `/applications/workspace/${workspaceId}/`, { name, type: "builder" });
  const pages = [["Accueil", "/"], ["Projets", "/projets"], ["Contact", "/contact"]];
  for (const [title, path] of pages) {
    const page = await api(session, "POST", `/builder/${builder.id}/pages/`, { name: title, path });
    await api(session, "POST", `/builder/page/${page.id}/elements/`, { type: "heading", value: `'${title}'`, level: 1 });
    await api(session, "POST", `/builder/page/${page.id}/elements/`, { type: "text", value: `'Page « ${title} » du portail de test.'` });
    await api(session, "POST", `/builder/page/${page.id}/elements/`, { type: "button", value: "'En savoir plus'" });
    await api(session, "POST", `/builder/page/${page.id}/elements/`, { type: "link", value: "'Retour à l’accueil'", navigate_to_url: "'/'" });
  }
}

async function seedAutomation(session: Session, workspaceId: number, name: string, source: TableBuilder, target: TableBuilder) {
  const automation = await api(session, "POST", `/applications/workspace/${workspaceId}/`, { name, type: "automation" });
  const workflow = await api(session, "POST", `/automation/${automation.id}/workflows/`, { name: "Nouvelle ligne → suivi" });
  const trigger = await api(session, "POST", `/automation/workflow/${workflow.id}/nodes/`, { type: "local_supertask_rows_created" });
  await api(session, "PATCH", `/automation/node/${trigger.id}/`, { service: { table_id: source.id } }).catch(() => undefined);
  const action = await api(session, "POST", `/automation/workflow/${workflow.id}/nodes/`, { type: "local_supertask_create_row", reference_node_id: trigger.id, position: "south" });
  await api(session, "PATCH", `/automation/node/${action.id}/`, { service: { table_id: target.id } }).catch(() => undefined);
  const webhook = await api(session, "POST", `/automation/${automation.id}/workflows/`, { name: "Webhook entrant" });
  await api(session, "POST", `/automation/workflow/${webhook.id}/nodes/`, { type: "http_trigger", service: { uid: crypto.randomUUID() } });
}

async function seedProduct(admin: Session, workspaceId: number) {
  const database = await api(admin, "POST", `/applications/workspace/${workspaceId}/`, { name: "Produit", type: "database" });
  const sprints = await createTable(admin, database.id, "Sprints");
  await sprints.renamePrimary("Sprint");
  await sprints.field("Statut", "single_select", SELECT(["Planifié", "En cours", "Terminé"], ["light-gray", "blue", "green"]));
  await sprints.field("Début", "date", { date_format: "EU" });
  await sprints.field("Fin", "date", { date_format: "EU" });
  await sprints.field("Objectif", "long_text");
  const sprintRows = await sprints.rows(Array.from({ length: 8 }, (_, index) => ({
    Sprint: `Sprint ${index + 21}`,
    Statut: sprints.option("Statut", index < 5 ? "Terminé" : index === 5 ? "En cours" : "Planifié"),
    Début: day(-70 + index * 14),
    Fin: day(-57 + index * 14),
    Objectif: "Stabiliser, mesurer et livrer la prochaine version.",
  })));

  const features = await createTable(admin, database.id, "Fonctionnalités");
  await features.renamePrimary("Fonctionnalité");
  await features.field("Sprint", "link_row", { link_row_table_id: sprints.id, has_related_field: true });
  await features.field("Statut", "single_select", SELECT(["Idée", "Spécifiée", "En développement", "En test", "Livrée"], ["light-gray", "purple", "blue", "orange", "green"]));
  await features.field("Équipes", "multiple_select", SELECT(["Web", "Mobile", "API", "Données"]));
  await features.field("Points", "number", { number_decimal_places: 0 });
  await features.field("Impact", "rating", { max_value: 5, style: "heart", color: "red" });
  await features.field("Lancement", "date", { date_format: "EU" });
  await features.field("Ticket", "url");
  const names = ["Connexion SSO", "Export PDF", "Mode hors ligne", "Recherche globale", "Notifications push", "Thème sombre", "Import CSV", "Partage public", "Historique des versions", "Commentaires", "Rôles avancés", "Tableau de bord mobile", "API publique", "Webhooks", "Raccourcis clavier"];
  await features.rows(names.map((name) => ({
    Fonctionnalité: name,
    Sprint: [pick(sprintRows).id],
    Statut: features.option("Statut", pick(["Idée", "Spécifiée", "En développement", "En test", "Livrée"])),
    Équipes: pickSome(["Web", "Mobile", "API", "Données"], 2).map((value) => features.option("Équipes", value)),
    Points: pick([1, 2, 3, 5, 8, 13]),
    Impact: between(1, 5),
    Lancement: day(between(-30, 90)),
    Ticket: `https://tickets.example.com/PROD-${between(100, 999)}`,
  })));
  await createViews(admin, features, { status: "Statut", end: "Lancement", formFields: ["Fonctionnalité", "Équipes", "Points"] });
  await createViews(admin, sprints, { status: "Statut", start: "Début", end: "Fin", formFields: ["Sprint", "Objectif"] });

  const bugs = await createTable(admin, database.id, "Bugs");
  await bugs.renamePrimary("Titre");
  await bugs.field("Gravité", "single_select", SELECT(["Mineure", "Majeure", "Critique"], ["yellow", "orange", "red"]));
  await bugs.field("Reproductible", "boolean");
  await bugs.field("Signalé par", "email");
  await bugs.field("Version", "text");
  await bugs.field("Résolu le", "date", { date_format: "EU" });
  await bugs.rows(Array.from({ length: 25 }, (_, index) => ({
    Titre: pick(["Bouton inactif", "Erreur d'affichage", "Lenteur au chargement", "Export vide", "Traduction manquante", "Crash au démarrage"]) + ` #${index + 1}`,
    Gravité: bugs.option("Gravité", pick(["Mineure", "Majeure", "Critique"])),
    Reproductible: random() > 0.3,
    "Signalé par": `testeur${between(1, 9)}@example.com`,
    Version: `2.${between(0, 4)}.${between(0, 9)}`,
    "Résolu le": random() > 0.5 ? day(-between(0, 40)) : null,
  })));

  await seedDashboard(admin, workspaceId, "Qualité", bugs);
  await seedDocument(admin, workspaceId, "Spécifications", [["Vision produit", "Pourquoi, pour qui et comment."], ["Spéc : export PDF", "Comportement attendu et cas limites."]]);
  await seedWhiteboard(admin, workspaceId, "Rétrospectives", [["Rétro sprint 26", "retrospective"], ["Plan trimestriel", "project"]]);
  await seedAutomation(admin, workspaceId, "Automatisations produit", bugs, features);
}

async function seedPersonal(admin: Session, workspaceId: number) {
  const database = await api(admin, "POST", `/applications/workspace/${workspaceId}/`, { name: "Maison", type: "database" });
  const budget = await createTable(admin, database.id, "Budget");
  await budget.renamePrimary("Libellé");
  await budget.field("Catégorie", "single_select", SELECT(["Logement", "Courses", "Transport", "Loisirs", "Santé"]));
  await budget.field("Montant", "number", { number_decimal_places: 2, number_negative: true, number_suffix: " €" });
  await budget.field("Date", "date", { date_format: "EU" });
  await budget.field("Récurrent", "boolean");
  await budget.rows(Array.from({ length: 40 }, (_, index) => ({
    Libellé: pick(["Loyer", "Supermarché", "Abonnement transport", "Cinéma", "Pharmacie", "Restaurant", "Électricité"]),
    Catégorie: budget.option("Catégorie", pick(["Logement", "Courses", "Transport", "Loisirs", "Santé"])),
    Montant: -between(5, 900),
    Date: day(-index * 2),
    Récurrent: random() > 0.6,
  })));
  const books = await createTable(admin, database.id, "Lectures");
  await books.renamePrimary("Titre");
  await books.field("Auteur", "text");
  await books.field("Genres", "multiple_select", SELECT(["Roman", "Essai", "BD", "Science", "Histoire"]));
  await books.field("Note", "rating", { max_value: 5 });
  await books.field("Lu", "boolean");
  await books.field("Terminé le", "date", { date_format: "EU" });
  await books.rows([
    ["L'Étranger", "Albert Camus"], ["Sapiens", "Yuval Noah Harari"], ["Persepolis", "Marjane Satrapi"],
    ["Le Petit Prince", "Antoine de Saint-Exupéry"], ["Cosmos", "Carl Sagan"], ["Les Misérables", "Victor Hugo"],
  ].map(([title, author]) => ({
    Titre: title,
    Auteur: author,
    Genres: pickSome(["Roman", "Essai", "BD", "Science", "Histoire"], 2).map((value) => books.option("Genres", value)),
    Note: between(3, 5),
    Lu: random() > 0.4,
    "Terminé le": random() > 0.4 ? day(-between(0, 300)) : null,
  })));
  await seedDocument(admin, workspaceId, "Notes", [["Idées", "Des idées en vrac."], ["Voyages", "Destinations et souvenirs."]]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const TEST_USERS = [
  ["alice", "Alice", "Martin"],
  ["bruno", "Bruno", "Leroy"],
  ["chloe", "Chloé", "Durand"],
  ["david", "David", "Petit"],
  ["emma", "Emma", "Moreau"],
] as const;

async function main() {
  console.log("1/5 Arrêt de l'API locale et remise à zéro de l'état local");
  run("systemctl", ["--user", "stop", "supertask-dev-api.service"]);
  for (const dir of STATE_DIRS) rmSync(dir, { recursive: true, force: true });
  run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"]);

  console.log("2/5 Compte administrateur copié depuis la production, comptes de test");
  const [admin] = d1Json("--remote", `SELECT email, username, first_name, last_name, password, is_superuser, last_password_change FROM auth_user WHERE email = ${quote(ADMIN_EMAIL)}`, cloudflareEnv());
  if (!admin) throw new Error(`${ADMIN_EMAIL} was not found in production.`);
  const [profile] = d1Json("--remote", `SELECT p.language, p.timezone, p.completed_onboarding, p.completed_guided_tours FROM core_userprofile p JOIN auth_user u ON u.id = p.user_id WHERE u.email = ${quote(ADMIN_EMAIL)}`, cloudflareEnv());
  const testHash = await hashPassword(TEST_PASSWORD);
  const now = new Date().toISOString();
  const accounts = [
    { email: admin.email, username: admin.username, first: admin.first_name, last: admin.last_name, hash: admin.password, staff: 1, superuser: admin.is_superuser, changed: admin.last_password_change },
    ...TEST_USERS.map(([login, first, last]) => ({ email: `${login}@example.com`, username: `${login}@example.com`, first, last, hash: testHash, staff: 0, superuser: 0, changed: null })),
  ];
  d1LocalFile(accounts.map((account, index) => `
INSERT INTO auth_user (id, email, username, first_name, last_name, password, is_staff, is_active, is_superuser, date_joined, last_password_change)
  VALUES (${index + 1}, ${quote(account.email)}, ${quote(account.username)}, ${quote(account.first)}, ${quote(account.last)}, ${quote(account.hash)}, ${account.staff}, 1, ${account.superuser}, ${quote(now)}, ${quote(account.changed)});
INSERT INTO core_userprofile (user_id, language, timezone, email_notification_frequency, completed_onboarding, completed_guided_tours, to_be_deleted, email_verified, user_session_expiry_seconds)
  VALUES (${index + 1}, ${quote(index === 0 ? profile?.language || "fr" : "fr")}, ${quote(index === 0 ? profile?.timezone : null)}, 'instant', 1, ${quote(index === 0 ? profile?.completed_guided_tours || "[]" : '["sidebar","database","builder","automation"]')}, 0, 1, 604800);
INSERT OR IGNORE INTO core_authprovideruser (auth_provider_id, user_id) SELECT id, ${index + 1} FROM core_authprovider WHERE type = 'password';`).join("\n"));
  d1LocalFile("UPDATE core_settings SET show_admin_signup_page = 0 WHERE id = 1;");

  console.log("3/5 Démarrage de l'API locale");
  run("systemctl", ["--user", "start", "supertask-dev-api.service"]);
  await waitForApi();
  const signingKey = /JWT_SIGNING_KEY="?([^"\n]+)"?/.exec(readFileSync(".dev.vars", "utf8"))?.[1];
  if (!signingKey) throw new Error(".dev.vars has no JWT_SIGNING_KEY.");
  const session = async (id: number, email: string): Promise<Session> => ({ id, email, token: await signAccessToken({ user_id: id, email, username: email }, signingKey, 240) });
  const adminSession = await session(1, admin.email);
  const users: Record<string, Session> = {};
  for (const [index, [login]] of TEST_USERS.entries()) users[login] = await session(index + 2, `${login}@example.com`);

  console.log("4/5 Workspaces, membres et applications");
  const agency = await api(adminSession, "POST", "/workspaces/", { name: "Agence Nova" });
  // AI fields need an enabled provider; this one points at a local Ollama.
  await api(adminSession, "PATCH", `/workspaces/${agency.id}/settings/generative-ai/`, {
    ollama: { host: "http://127.0.0.1:11434", models: ["llama3.1"] },
  });
  const product = await api(adminSession, "POST", "/workspaces/", { name: "Studio Produit" });
  const personal = await api(adminSession, "POST", "/workspaces/", { name: "Perso" });
  const memberships: Array<[number, string, string]> = [
    [agency.id, "alice", "ADMIN"], [agency.id, "bruno", "BUILDER"], [agency.id, "chloe", "EDITOR"], [agency.id, "david", "COMMENTER"], [agency.id, "emma", "VIEWER"],
    [product.id, "bruno", "ADMIN"], [product.id, "chloe", "BUILDER"], [product.id, "alice", "EDITOR"], [product.id, "emma", "VIEWER"],
  ];
  d1LocalFile(memberships.map(([workspaceId, login, role], index) =>
    `INSERT INTO core_workspaceuser (workspace_id, user_id, "order", permissions, to_be_deleted) VALUES (${workspaceId}, ${users[login].id}, ${index + 2}, '${role}', 0);`).join("\n"));
  const images = await uploadImages(adminSession);
  await seedAgency(adminSession, users, agency.id, images);
  await seedProduct(adminSession, product.id);
  await seedPersonal(adminSession, personal.id);

  console.log("5/5 Terminé");
  const [counts] = d1Json("--local", `SELECT (SELECT count(*) FROM core_workspace) AS workspaces, (SELECT count(*) FROM core_application) AS applications, (SELECT count(*) FROM database_table) AS tables, (SELECT count(*) FROM database_field) AS fields, (SELECT count(*) FROM database_view) AS views, (SELECT count(*) FROM auth_user) AS users, (SELECT count(*) FROM database_rowcomment) AS comments`);
  console.log(counts);
}

await main();
