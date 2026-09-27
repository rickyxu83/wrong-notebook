
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { setupGlobalProxy } = await import('./lib/global-proxy');
        setupGlobalProxy();

        // 复活容器重启时被杀死的分析任务（尸体任务永远挂在 running，会导致前端反复恢复）
        const { recoverStuckAnalyzeJobs } = await import('./lib/analyze-jobs');
        void recoverStuckAnalyzeJobs();
    }
}
