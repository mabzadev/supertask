import { Hono } from "hono";
import type { Env, RequestVariables } from "../../types/env";
import { tableRouter } from "./tables";
import { fieldRouter } from "./fields";
import { rowRouter } from "./rows";
import { viewRouter } from "./views";
import { webhookRouter } from "./webhooks";
import { tokenRouter } from "./tokens";
import { exportRouter, publicViewExportRouter } from "./export";
import { dataSyncRouter } from "./data-sync";
import { fieldRulesRouter } from "./field-rules";
import { formulaRouter } from "./formula";

const database = new Hono<{ Bindings: Env; Variables: RequestVariables }>();

function mount(path: string, router: Hono<any>) {
  database.route(path, router);
  database.route(path + "/", router);
}

mount("/tables", tableRouter);
mount("/fields", fieldRouter);
mount("/rows", rowRouter);
mount("/views", viewRouter);
mount("/webhooks", webhookRouter);
mount("/tokens", tokenRouter);
mount("/export", exportRouter);
mount("/view", publicViewExportRouter);
mount("/data-sync", dataSyncRouter);
mount("/field-rules", fieldRulesRouter);
mount("/formula", formulaRouter);

export { database as databaseRouter };
