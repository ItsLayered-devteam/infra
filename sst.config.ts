import { SSTConfig } from "sst";
import { Api, Cron, NextjsSite, RDS, EventBus, Config, Function, Queue } from "sst/constructs";

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

    app.stack(function AppStack({ stack }) {
      const database = {
        supabaseUrl: new Config.Secret(stack, "SUPABASE_URL"),
        supabaseAnonKey: new Config.Secret(stack, "SUPABASE_ANON_KEY"),
        supabaseJwtSecret: new Config.Secret(stack, "SUPABASE_JWT_SECRET"),
        databaseUrl: new Config.Secret(stack, "DATABASE_URL"),
        directUrl: new Config.Secret(stack, "DIRECT_URL"),
      };

      const shopifyWebhookQueue = new Queue(stack, "ShopifyWebhookQueue", {
        consumer: {
          function: {
            handler: "../backend-api/dist/jobs/shopify-webhook.handler.handler",
            bind: [database.databaseUrl, database.directUrl],
          },
        },
      });

      const sharedEnv = { NODE_ENV: isProd ? "production" : "development", LOG_LEVEL: config.logLevel };

      const backendAPI = new Api(stack, "backend-api", {
        defaults: {
          function: {
            runtime: "nodejs18.x",
            timeout: config.timeout as any,
            memorySize: config.memorySize as any,
            environment: { ...sharedEnv, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" },
            bind: [
              database.supabaseUrl, 
              database.supabaseAnonKey, 
              database.databaseUrl, 
              database.directUrl,
              shopifyWebhookQueue,
            ],
          },
        },
        routes: { "ANY /{proxy+}": { function: { handler: "../backend-api/dist/lambda.handler" } } },
      });

      const mobileBff = new Api(stack, "mobile-bff", {
        defaults: {
          function: {
            runtime: "nodejs18.x",
            timeout: config.timeout as any,
            memorySize: config.memorySize as any,
            environment: { ...sharedEnv },
            bind: [
              database.supabaseUrl,
              database.supabaseAnonKey,
              database.supabaseJwtSecret,
              database.databaseUrl,
              database.directUrl,
              backendAPI,
            ],
          },
        },
        routes: { "ANY /{proxy+}": { function: { handler: "../mobile-bff/dist/lambda.main" } } },
      });

      new Cron(stack, "expire-points-job", {
        schedule: "cron(0 */4 * * ? *)",
        job: {
          function: {
            handler: "../backend-api/dist/jobs/expire-points.handler.handler",
            runtime: "nodejs18.x",
            timeout: "5 minutes",
            memorySize: "1024 MB",
            environment: { 
              DATABASE_URL: (database.databaseUrl as any).value, 
              DIRECT_URL: (database.directUrl as any).value, 
              PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1" 
            },
            bind: [database.databaseUrl, database.directUrl],
          },
        },
      });

      new NextjsSite(stack, "admin-dashboard", {
        path: "../frontend-web-admin",
        environment: {
          NEXT_PUBLIC_BACKEND_API_URL: backendAPI.url,
          NEXT_PUBLIC_SUPABASE_URL: (database.supabaseUrl as any).value,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: (database.supabaseAnonKey as any).value,
        },
        customDomain: config.domain ? { domainName: config.domain } : undefined,
      });
    });
  },
} satisfies SSTConfig; 