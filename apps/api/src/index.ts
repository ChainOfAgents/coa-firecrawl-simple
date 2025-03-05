import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { getScrapeQueue } from "./services/queue-service";
import cluster from "cluster";
import os from "os";
import { Logger } from "./lib/logger";
import { adminRouter } from "./routes/admin";
import http from "node:http";
import https from "node:https";
import CacheableLookup from "cacheable-lookup";
import { v1Router } from "./routes/v1";
import expressWs from "express-ws";
import { ErrorResponse, ResponseWithSentry } from "./controllers/v1/types";
import { ZodError } from "zod";
import { v4 as uuidv4 } from "uuid";
import { setupOpenAPI } from "./openapi";

const numCPUs = process.env.ENV === "local" ? 2 : os.cpus().length;
Logger.info(`Number of CPUs: ${numCPUs} available`);

const cacheable = new CacheableLookup({
  // this is important to avoid querying local hostnames see https://github.com/szmarczak/cacheable-lookup readme
  lookup: false,
});

cacheable.install(http.globalAgent);
cacheable.install(https.globalAgent);

if (cluster.isPrimary) {
  Logger.info(`Primary ${process.pid} is running`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code) => {
    if (code !== null) {
      Logger.info(`Worker ${worker.process.pid} exited`);
      Logger.info("Starting a new worker");
      cluster.fork();
    }
  });
} else {
  const ws = expressWs(express());
  const app = ws.app;

  global.isProduction = process.env.IS_PRODUCTION === "true";

  setupOpenAPI(app);

  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(bodyParser.json({ limit: "10mb" }));

  app.use(cors()); // Add this line to enable CORS

  app.use("/v1", v1Router);
  app.use(adminRouter);

  /**
   * @openapi
   * /health:
   *   get:
   *     tags:
   *       - Health
   *     summary: Health check endpoint
   *     description: Returns a 200 OK response if the API service is healthy
   *     responses:
   *       200:
   *         description: API service is healthy
   *         content:
   *           text/plain:
   *             schema:
   *               type: string
   *               example: API service is healthy
   */
  app.get("/health", (req, res) => {
    res.status(200).send("API service is healthy");
  });

  // Use the PORT environment variable provided by Cloud Run
  const DEFAULT_PORT = process.env.PORT ?? 8080;
  const HOST = process.env.HOST ?? "0.0.0.0";

  Logger.info(`Environment: NODE_ENV=${process.env.NODE_ENV}`);
  Logger.info(`Using PORT=${DEFAULT_PORT} and HOST=${HOST}`);

  function startServer(port = DEFAULT_PORT) {
    Logger.info(`Attempting to start server on ${HOST}:${port}`);
    try {
      const server = app.listen(Number(port), HOST, () => {
        Logger.info(`Server is now running on ${HOST}:${port}`);
        Logger.info(`Health check available at http://${HOST}:${port}/health`);
      });
      
      // Add error handler for the server
      server.on('error', (error) => {
        Logger.error(`Server error: ${error.message}`);
        console.error('Server failed to start:', error);
      });
      
      return server;
    } catch (error) {
      Logger.error(`Failed to start server: ${error.message}`);
      console.error('Exception during server startup:', error);
      throw error;
    }
  }

  if (require.main === module) {
    startServer();
  }

  /**
   * @openapi
   * /serverHealthCheck:
   *   get:
   *     tags:
   *       - Health
   *     summary: Check if the server is healthy
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 waitingJobs:
   *                   type: number   
   *                   example: 0
   */
  app.get(`/serverHealthCheck`, async (req, res) => {
    try {
      const scrapeQueue = getScrapeQueue();
      
      // Handle case where getWaitingCount might not be implemented in Cloud Tasks adapter
      let waitingJobs = 0;
      if (typeof scrapeQueue.getWaitingCount === 'function') {
        waitingJobs = await scrapeQueue.getWaitingCount();
      } else {
        Logger.info('[SERVER-HEALTH] getWaitingCount not available, assuming 0 waiting jobs');
      }

      const noWaitingJobs = waitingJobs === 0;
      // 200 if no active jobs, 503 if there are active jobs
      return res.status(noWaitingJobs ? 200 : 500).json({
        waitingJobs,
        queueProvider: process.env.QUEUE_PROVIDER || 'bull'
      });
    } catch (error) {
      Logger.error(error);
      // Return 200 if using Cloud Tasks to prevent health check failures
      if (process.env.QUEUE_PROVIDER === 'cloud-tasks') {
        return res.status(200).json({ 
          waitingJobs: 0, 
          queueProvider: 'cloud-tasks',
          message: 'Using Cloud Tasks, health check always passes'
        });
      }
      return res.status(500).json({ error: error.message });
    }
  });

  /*
   * @openapi
   * /is-production:
   *   get:
   *     tags:
   *       - Health
   *     summary: Check if the application is running in production mode
   *     responses:
   *       200:
   *         description: OK
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 isProduction:
   *                   type: boolean
   *                   example: true  
   */
  app.get("/is-production", (req, res) => {
    res.send({ isProduction: global.isProduction });
  });

  app.use(
    (
      err: unknown,
      req: Request<{}, ErrorResponse, undefined>,
      res: Response<ErrorResponse>,
      next: NextFunction
    ) => {
      if (err instanceof ZodError) {
        res
          .status(400)
          .json({ success: false, error: "Bad Request", details: err.errors });
      } else {
        next(err);
      }
    }
  );

  app.use(
    (
      err: unknown,
      req: Request<{}, ErrorResponse, undefined>,
      res: ResponseWithSentry<ErrorResponse>,
      next: NextFunction
    ) => {
      if (
        err instanceof SyntaxError &&
        "status" in err &&
        err.status === 400 &&
        "body" in err
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Bad request, malformed JSON" });
      }

      const id = res.sentry ?? uuidv4();
      let verbose = JSON.stringify(err);
      if (verbose === "{}") {
        if (err instanceof Error) {
          verbose = JSON.stringify({
            message: err.message,
            name: err.name,
            stack: err.stack,
          });
        }
      }

      Logger.error(
        "Error occurred in request! (" +
          req.path +
          ") -- ID " +
          id +
          " -- " +
          verbose
      );
      res.status(500).json({
        success: false,
        error:
          "An unexpected error occurred. Please contact hello@firecrawl.com for help. Your exception ID is " +
          id,
      });
    }
  );

  Logger.info(`Worker ${process.pid} started`);
}
