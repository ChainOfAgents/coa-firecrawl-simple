import { stateManager } from "../services/state-management/firestore-state";
import { PlanType } from "../../src/types";
import { Logger } from "./logger";

// Default team ID for system-generated requests
const DEFAULT_TEAM_ID = 'system';
const COLLECTION_PREFIX = "team_jobs:";

export async function addJobPriority(team_id, job_id) {
  try {
    // Use default team_id if undefined
    const safeTeamId = team_id || DEFAULT_TEAM_ID;
    
    // Add job to Firestore
    await stateManager.addTeamJob(safeTeamId, job_id);
    Logger.debug(`Added job ${job_id} to team ${safeTeamId} priority tracking`);
  } catch (e) {
    Logger.error(`Add job priority failed: ${team_id}, ${job_id}: ${e}`);
  }
}

export async function deleteJobPriority(team_id, job_id) {
  try {
    // Use default team_id if undefined
    const safeTeamId = team_id || DEFAULT_TEAM_ID;
    
    // Remove job from Firestore
    await stateManager.removeTeamJob(safeTeamId, job_id);
    Logger.debug(`Removed job ${job_id} from team ${safeTeamId} priority tracking`);
  } catch (e) {
    Logger.error(`Delete job priority failed: ${team_id}, ${job_id}: ${e}`);
  }
}

export async function getJobPriority({
  plan,
  team_id,
  basePriority = 10,
}: {
  plan: PlanType;
  team_id?: string; // Make team_id optional
  basePriority?: number;
}): Promise<number> {
  try {
    // Use default team_id if undefined
    const safeTeamId = team_id || DEFAULT_TEAM_ID;
    
    // Get team job count from Firestore
    const jobCount = await stateManager.getTeamJobCount(safeTeamId);
    Logger.debug(`Team ${safeTeamId} has ${jobCount} active jobs`);

    // Base priority is 10, lower is higher priority
    let priority = basePriority;

    // Adjust priority based on plan
    if (plan === "free") {
      // Free plan gets lower priority as job count increases
      if (jobCount > 10) {
        priority = 15;
      } else if (jobCount > 5) {
        priority = 12;
      }
    } else if (plan === "starter" || plan === "hobby") {
      // Starter/Hobby plans get slightly better priority
      if (jobCount > 20) {
        priority = 12;
      } else if (jobCount > 10) {
        priority = 10;
      } else {
        priority = 8;
      }
    } else if (plan === "standard" || plan === "standardnew") {
      // Standard plans get good priority
      if (jobCount > 30) {
        priority = 8;
      } else if (jobCount > 15) {
        priority = 6;
      } else {
        priority = 5;
      }
    } else if (plan === "scale" || plan === "growth" || plan === "growthdouble") {
      // Scale/Growth plans get highest priority
      if (jobCount > 50) {
        priority = 5;
      } else if (jobCount > 25) {
        priority = 3;
      } else {
        priority = 2;
      }
    }

    // Special case for system team
    if (safeTeamId === DEFAULT_TEAM_ID) {
      // System jobs get highest priority
      priority = 1;
    }

    return priority;
  } catch (e) {
    Logger.error(`Get job priority failed for team ${team_id}: ${e}`);
    // Return default priority on error
    return basePriority;
  }
}
