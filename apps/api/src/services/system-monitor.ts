import si from 'systeminformation';
import { Mutex } from "async-mutex";

// Use higher default thresholds and check env variables in a consistent way
const MAX_CPU = process.env.MAX_CPU ? parseFloat(process.env.MAX_CPU) : 0.95;
const MAX_RAM = process.env.MAX_RAM ? parseFloat(process.env.MAX_RAM) : 0.95;
const CACHE_DURATION = process.env.SYS_INFO_MAX_CACHE_DURATION ? parseFloat(process.env.SYS_INFO_MAX_CACHE_DURATION) : 150;

class SystemMonitor {
    private static instance: SystemMonitor;
    private static instanceMutex = new Mutex();

    private cpuUsageCache: number | null = null;
    private memoryUsageCache: number | null = null;
    private lastCpuCheck: number = 0;
    private lastMemoryCheck: number = 0;

    private constructor() {}

    public static async getInstance(): Promise<SystemMonitor> {
        if (SystemMonitor.instance) {
            return SystemMonitor.instance;
        }
        
        await this.instanceMutex.runExclusive(async () => {
            if (!SystemMonitor.instance) {
                SystemMonitor.instance = new SystemMonitor();
            }
        });
    
        return SystemMonitor.instance;
    }

    private async checkMemoryUsage() {
        const now = Date.now();
        if (this.memoryUsageCache !== null && (now - this.lastMemoryCheck) < CACHE_DURATION) {
            return this.memoryUsageCache;
        }

        const memoryData = await si.mem();
        const totalMemory = memoryData.total;
        const availableMemory = memoryData.available;
        const usedMemory = totalMemory - availableMemory;
        const usedMemoryPercentage = (usedMemory / totalMemory);

        this.memoryUsageCache = usedMemoryPercentage;
        this.lastMemoryCheck = now;

        return usedMemoryPercentage;
    }

    private async checkCpuUsage() {
        const now = Date.now();
        if (this.cpuUsageCache !== null && (now - this.lastCpuCheck) < CACHE_DURATION) {
            return this.cpuUsageCache;
        }

        const cpuData = await si.currentLoad();
        const cpuLoad = cpuData.currentLoad / 100;

        this.cpuUsageCache = cpuLoad;
        this.lastCpuCheck = now;

        return cpuLoad;
    }

    public async acceptConnection() {
        const cpuUsage = await this.checkCpuUsage();
        const memoryUsage = await this.checkMemoryUsage();

        // Debug logging to help diagnose resource issues
        if (process.env.LOGGING_LEVEL === 'DEBUG') {
            console.log(`DEBUG: CPU usage: ${(cpuUsage * 100).toFixed(2)}%, Memory usage: ${(memoryUsage * 100).toFixed(2)}%, Thresholds - CPU: ${(MAX_CPU * 100).toFixed(2)}%, RAM: ${(MAX_RAM * 100).toFixed(2)}%`);
        }

        return cpuUsage < MAX_CPU && memoryUsage < MAX_RAM;
    }

    public clearCache() {
        this.cpuUsageCache = null;
        this.memoryUsageCache = null;
        this.lastCpuCheck = 0;
        this.lastMemoryCheck = 0;
    }
}

export default SystemMonitor.getInstance();