import { SSTConfig } from "sst";
import { Api, Cron, NextjsSite, RDS, EventBus, Config, Function } from "sst/constructs";

export default {
  config(_input) {
    return {
      name: "layered-platform",
      region: "us-east-1",
    };
  },
  stacks(app) {
    // Environment-specific settings
    const isProd = app.stage === "prod";
    const isStaging = app.stage === "staging" || app.stage === "homolog";
    const isDev = !isProd && !isStaging;

    const envConfig = {
      prod: { domain: "admin.layered.com", apiDomain: "api.layered.com", logLevel: "warn", memorySize: "1024 MB", timeout: "30 seconds" },
      staging: { domain: "staging-admin.layered.com", apiDomain: "staging-api.layered.com", logLevel: "info", memorySize: "512 MB", timeout: "30 seconds" },
      dev: { domain: undefined, apiDomain: undefined, logLevel: "debug", memorySize: "512 MB", timeout: "30 seconds" }
    };
    const currentEnv = isProd ? 'prod' : isStaging ? 'staging' : 'dev';
    const config = envConfig[currentEnv];

    app.stack(function Database({ stack }) {
      const supabaseUrl = new Config.Secret(stack, "SUPABASE_URL");
      const supabaseAnonKey = new Config.Secret(stack, "SUPABASE_ANON_KEY");
      const databaseUrl = new Config.Secret(stack, "DATABASE_URL");
      const directUrl = new Config.Secret(stack, "DIRECT_URL");
      return { supabaseUrl, supabaseAnonKey, databaseUrl, directUrl };
    });

    app.stack(function APIs({ stack }) {
      const { supabaseUrl, supabaseAnonKey, databaseUrl, directUrl } = app.use(Database);
      const sharedEnv = { NODE_ENV: isProd ? "production" : "development", LOG_LEVEL: config.logLevel };

      const backendAPI = new Api(stack, "backend-api", {
        defaults: {
          function: {
            runtime: "nodejs18.x",
            timeout: config.timeout,
            memorySize: config.memorySize,
            environment: { ...sharedEnv, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" },
            bind: [supabaseUrl, supabaseAnonKey, databaseUrl, directUrl],
          },
        },
        routes: { "ANY /{proxy+}": { function: { handler: "../backend-api/dist/lambda.handler" } } },
      });

      return { backendAPIUrl: backendAPI.url };
    });

    app.stack(function Jobs({ stack }) {
      const { databaseUrl, directUrl } = app.use(Database);
      new Cron(stack, "expire-points-job", {
        schedule: "cron(0 */4 * * ? *)",
        job: {
          function: {
            handler: "../backend-api/src/jobs/expire-points.handler.handler",
            runtime: "nodejs18.x",
            timeout: "5 minutes",
            memorySize: "1024 MB",
            environment: { DATABASE_URL: databaseUrl.value, DIRECT_URL: directUrl.value, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" },
            bind: [databaseUrl, directUrl],
          },
        },
      });
    });

    app.stack(function Frontend({ stack }) {
      const { backendAPIUrl } = app.use(APIs);
      const { supabaseUrl, supabaseAnonKey } = app.use(Database);
      new NextjsSite(stack, "admin-dashboard", {
        path: "../frontend-web-admin",
        environment: {
          NEXT_PUBLIC_BACKEND_API_URL: backendAPIUrl,
          NEXT_PUBLIC_SUPABASE_URL: supabaseUrl.value,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey.value,
        },
        customDomain: config.domain ? { domainName: config.domain } : undefined,
      });
    });
  },
} satisfies SSTConfig; 