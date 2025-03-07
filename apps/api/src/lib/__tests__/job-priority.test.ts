import {
  getJobPriority,
  addJobPriority,
  deleteJobPriority,
} from "../job-priority";
import { stateManager } from "../../services/state-management/firestore-state";
import { PlanType } from "../../types";

jest.mock("../../services/state-management/firestore-state", () => ({
  stateManager: {
    addTeamJob: jest.fn(),
    removeTeamJob: jest.fn(),
    getTeamJobCount: jest.fn(),
  },
}));

describe("Job Priority Tests", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("addJobPriority should add job_id to the team jobs", async () => {
    const team_id = "team1";
    const job_id = "job1";
    await addJobPriority(team_id, job_id);
    expect(stateManager.addTeamJob).toHaveBeenCalledWith(team_id, job_id);
  });

  test("deleteJobPriority should remove job_id from team jobs", async () => {
    const team_id = "team1";
    const job_id = "job1";
    await deleteJobPriority(team_id, job_id);
    expect(stateManager.removeTeamJob).toHaveBeenCalledWith(team_id, job_id);
  });

  test("getJobPriority should return correct priority based on plan and job count", async () => {
    const team_id = "team1";
    const plan: PlanType = "standard";
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(20);

    const priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(6); // Based on standard plan with 20 jobs
    expect(stateManager.getTeamJobCount).toHaveBeenCalledWith(team_id);
  });

  test("getJobPriority should handle free plan correctly", async () => {
    const team_id = "team2";
    const plan: PlanType = "free";
    
    // Test with different job counts
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(3);
    let priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(10); // Base priority for free with few jobs
    
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(7);
    priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(12); // Lower priority for free with more jobs
    
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(15);
    priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(15); // Even lower priority for free with many jobs
  });

  test("getJobPriority should handle scale/growth plans correctly", async () => {
    const team_id = "team3";
    const plan: PlanType = "scale";
    
    // Test with different job counts
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(10);
    let priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(2); // High priority for scale with few jobs
    
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(30);
    priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(3); // Still high priority for scale with more jobs
    
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(60);
    priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(5); // Slightly lower priority for scale with many jobs
  });

  test("getJobPriority should handle system team correctly", async () => {
    const team_id = "system";
    const plan: PlanType = "free"; // Plan doesn't matter for system
    
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(100);
    const priority = await getJobPriority({ plan, team_id });
    expect(priority).toBe(1); // System jobs always get highest priority
  });

  test("getJobPriority should use default team_id if not provided", async () => {
    const plan: PlanType = "standard";
    (stateManager.getTeamJobCount as jest.Mock).mockResolvedValue(5);
    
    await getJobPriority({ plan });
    expect(stateManager.getTeamJobCount).toHaveBeenCalledWith("system");
  });

  test("getJobPriority should handle errors gracefully", async () => {
    const team_id = "team4";
    const plan: PlanType = "standard";
    const basePriority = 10;
    
    (stateManager.getTeamJobCount as jest.Mock).mockRejectedValue(new Error("Test error"));
    
    const priority = await getJobPriority({ plan, team_id, basePriority });
    expect(priority).toBe(basePriority); // Should return base priority on error
  });
});
