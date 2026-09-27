import { prisma } from "@/lib/prisma";

/**
 * 简化版艾宾浩斯复习计划（issue #88）。
 * 基于已有的 ReviewSchedule 表：每次复习完成后按间隔排下一次。
 * 间隔（天）：1, 2, 4, 7, 15, 30，答错回到第一档。
 */
export const REVIEW_INTERVALS_DAYS = [1, 2, 4, 7, 15, 30];

export function nextIntervalDate(stage: number, from: Date = new Date()): Date {
    const idx = Math.min(Math.max(stage, 0), REVIEW_INTERVALS_DAYS.length - 1);
    const d = new Date(from);
    d.setDate(d.getDate() + REVIEW_INTERVALS_DAYS[idx]);
    return d;
}

/** 新错题建立首个复习排期（录入 1 天后首复习） */
export async function ensureInitialSchedule(errorItemId: string, from?: Date) {
    const existing = await prisma.reviewSchedule.findFirst({
        where: { errorItemId },
    });
    if (existing) return existing;
    return prisma.reviewSchedule.create({
        data: { errorItemId, scheduledFor: nextIntervalDate(0, from) },
    });
}

/**
 * 返回当前用户"今日待复习"的错题 ID：
 * 有待排期、到期未完成、且未标记掌握的错题。
 * 对从未排期的老错题做懒补齐（立即到期）。
 */
export async function getDueErrorItemIds(userId: string): Promise<string[]> {
    const now = new Date();

    // 懒补齐：老数据没有排期记录 → 补一条立即到期的排期
    const unscheduled = await prisma.errorItem.findMany({
        where: { userId, masteryLevel: 0, reviewSchedules: { none: {} } },
        select: { id: true },
    });
    for (const item of unscheduled) {
        await prisma.reviewSchedule.create({
            data: { errorItemId: item.id, scheduledFor: now },
        }).catch(() => { /* 并发下重复补齐可忽略 */ });
    }

    const due = await prisma.reviewSchedule.findMany({
        where: {
            completedAt: null,
            scheduledFor: { lte: now },
            errorItem: { userId, masteryLevel: 0 },
        },
        select: { errorItemId: true },
        distinct: ['errorItemId'],
    });
    return due.map((d) => d.errorItemId);
}

/**
 * 完成一次复习：结清当前待排期，按结果排下一次。
 * 答对进入下一间隔档，答错回到第一档；已掌握的错题不再排期。
 */
export async function completeReview(errorItemId: string, isCorrect: boolean) {
    const now = new Date();

    const pending = await prisma.reviewSchedule.findFirst({
        where: { errorItemId, completedAt: null },
        orderBy: { scheduledFor: 'asc' },
    });
    if (pending) {
        await prisma.reviewSchedule.update({
            where: { id: pending.id },
            data: { completedAt: now, isCorrect },
        });
    }

    const completedCount = await prisma.reviewSchedule.count({
        where: { errorItemId, completedAt: { not: null } },
    });
    const stage = isCorrect ? completedCount : 0;

    const item = await prisma.errorItem.findUnique({
        where: { id: errorItemId },
        select: { masteryLevel: true },
    });
    if (item && item.masteryLevel === 0) {
        const next = await prisma.reviewSchedule.create({
            data: { errorItemId, scheduledFor: nextIntervalDate(stage, now) },
        });
        return { nextReviewAt: next.scheduledFor, stage };
    }
    return { nextReviewAt: null, stage };
}

/** 标记已掌握时：清除待排期；取消掌握时：重新建立排期 */
export async function syncSchedulesWithMastery(errorItemId: string, masteryLevel: number) {
    if (masteryLevel > 0) {
        await prisma.reviewSchedule.deleteMany({
            where: { errorItemId, completedAt: null },
        });
    } else {
        await ensureInitialSchedule(errorItemId);
    }
}
