import {
  CLOSE_CRON,
  getConfigIssues,
  OPEN_CRON,
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
      if (controller.cron === OPEN_CRON) {
        await openNightChannels(env, controller.scheduledTime);
        return;
      }

      if (controller.cron === CLOSE_CRON) {
        await closeNightChannels(env);
        return;
      }

      console.warn(`Ignoring unknown cron trigger: ${controller.cron}`);
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
            open: OPEN_CRON,
            close: CLOSE_CRON,
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
