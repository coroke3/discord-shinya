import {
  getConfigIssues,
  NIGHT_CRON,
  operationForScheduledTime,
  TIME_ZONE,
  type Env,
} from "./config";
import { closeNightChannels, openNightChannels } from "./lifecycle";

type WorkerFetch = NonNullable<ExportedHandler<Env>["fetch"]>;
type WorkerRequest = Parameters<WorkerFetch>[0];
type WorkerExecutionContext = Parameters<WorkerFetch>[2];

const handler: ExportedHandler<Env> = {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    try {
      if (controller.cron !== NIGHT_CRON) {
        console.warn(`Ignoring unknown cron trigger: ${controller.cron}`);
        return;
      }

      const operation = operationForScheduledTime(controller.scheduledTime);
      if (operation === "open") {
        await openNightChannels(env, controller.scheduledTime);
        return;
      }

      if (operation === "close") {
        await closeNightChannels(env);
        return;
      }

      console.warn(`Ignoring cron invocation at unexpected UTC time: ${controller.scheduledTime}`);
    } catch (error) {
      console.error(`Scheduled operation failed for ${controller.cron}`, error);
      throw error;
    }
  },

  async fetch(
    request: WorkerRequest,
    env: Env,
    _ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      const issues = getConfigIssues(env);
      return Response.json(
        {
          service: "discord-shinya",
          ok: issues.length === 0,
          configured: issues.length === 0,
          timezone: TIME_ZONE,
          schedules: {
            open: "0 15 * * *",
            close: "0 23 * * *",
            configured: NIGHT_CRON,
          },
          ...(issues.length > 0 ? { configurationIssues: issues } : {}),
        },
        { status: issues.length === 0 ? 200 : 503 },
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

export default handler;
