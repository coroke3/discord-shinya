import {
  getConfigIssues,
  NIGHT_CRON,
  operationForScheduledTime,
  TIME_ZONE,
  type Env,
} from "./config";
import { NightCoordinator } from "./coordinator";

type WorkerFetch = NonNullable<ExportedHandler<Env>["fetch"]>;
type WorkerRequest = Parameters<WorkerFetch>[0];
type WorkerExecutionContext = Parameters<WorkerFetch>[2];

export { NightCoordinator };

const handler: ExportedHandler<Env> = {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron !== NIGHT_CRON) {
      console.warn(`Ignoring unknown cron trigger: ${controller.cron}`);
      return;
    }

    const operation = operationForScheduledTime(controller.scheduledTime);
    if (!operation) {
      console.warn(`Ignoring cron invocation at unexpected UTC time: ${controller.scheduledTime}`);
      return;
    }

    const configurationIssues = getConfigIssues(env);
    if (configurationIssues.length > 0) {
      throw new Error(`Scheduled operation blocked by invalid configuration: ${configurationIssues.join("; ")}`);
    }

    const coordinator = getCoordinator(env);
    if (!coordinator) {
      throw new Error("NIGHT_COORDINATOR Durable Object binding is missing");
    }

    const response = await coordinator.fetch(
      new Request("https://discord-shinya.internal/operation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, scheduledTime: controller.scheduledTime }),
      }),
    );
    if (!response.ok) {
      throw new Error(`NightCoordinator rejected ${operation} (${response.status})`);
    }
  },

  async fetch(
    request: WorkerRequest,
    env: Env,
    _ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || (url.pathname !== "/" && url.pathname !== "/health")) {
      return new Response("Not Found", { status: 404 });
    }

    const issues = getConfigIssues(env);
    if (issues.length > 0) {
      return Response.json(
        {
          service: "discord-shinya",
          ok: false,
          configured: false,
          timezone: TIME_ZONE,
          schedules: {
            open: "0 15 * * *",
            openDeep: "0 18 * * *",
            close: "0 23 * * *",
            configured: NIGHT_CRON,
          },
          configurationIssues: issues,
        },
        { status: 503 },
      );
    }

    const coordinator = getCoordinator(env);
    if (!coordinator) {
      return Response.json(
        {
          service: "discord-shinya",
          ok: false,
          configured: true,
          timezone: TIME_ZONE,
          schedules: {
            open: "0 15 * * *",
            openDeep: "0 18 * * *",
            close: "0 23 * * *",
            configured: NIGHT_CRON,
          },
          error: "NIGHT_COORDINATOR Durable Object binding is missing",
        },
        { status: 503 },
      );
    }

    const health = await coordinator.fetch(new Request("https://discord-shinya.internal/health"));
    const payload = await health.json<unknown>();
    return Response.json(
      {
        service: "discord-shinya",
        configured: true,
        timezone: TIME_ZONE,
        schedules: {
          open: "0 15 * * *",
          openDeep: "0 18 * * *",
          close: "0 23 * * *",
          configured: NIGHT_CRON,
        },
        ...(payload as Record<string, unknown>),
      },
      { status: health.ok ? 200 : 503 },
    );
  },
};

function getCoordinator(env: Env) {
  return env.NIGHT_COORDINATOR?.getByName(env.DISCORD_GUILD_ID);
}

export default handler;
