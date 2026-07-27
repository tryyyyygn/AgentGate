import type { ActiveRequest } from "../types";

function startedAtMillis(request: ActiveRequest): number {
  const value = Date.parse(request.startedAt);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 把「只带活跃请求的增量通知」合进现有列表。
 *
 * 传输途中每 200ms 一次的进度通知，原本推的是整部三天历史。那部分根本
 * 没变，白白序列化过来——主进程实测吃掉了网关转发路径八成六的 CPU。现在只推变动
 * 记录，并可同时移除已过期的历史行。
 *
 * 正常情况下活跃请求在 start() 时就已经由一次全量通知放进列表了；但 bootstrap
 * 与事件可能交错返回，不能假定渲染端一定先收到那次通知。找不到的请求要追加，
 * 否则这条请求会一直消失到下一次完整刷新。
 */
export function mergeActiveRequests(
  current: ActiveRequest[],
  patch: ActiveRequest[],
  /** 可选：保留窗口淘汰的记录 ID。 */
  removedIds: string[] = [],
): ActiveRequest[] {
  if (patch.length === 0 && removedIds.length === 0) return current;
  const fresh = new Map(patch.map((request) => [request.id, request]));
  const removed = new Set(removedIds);
  const merged: ActiveRequest[] = [];
  const known = new Set<string>();
  for (const request of current) {
    if (removed.has(request.id)) continue;
    const replacement = fresh.get(request.id);
    merged.push(replacement ?? request);
    known.add(request.id);
  }
  for (const request of patch) {
    if (removed.has(request.id) || known.has(request.id)) continue;
    // bootstrap 与 start 事件交错时，新行可能是未知 ID；按开始时间插入，
    // 否则它会被追加到三天历史末尾，甚至落出动态页的可见窗口。
    const position = merged.findIndex(
      (existing) => startedAtMillis(request) > startedAtMillis(existing),
    );
    if (position < 0) merged.push(request);
    else merged.splice(position, 0, request);
    known.add(request.id);
  }
  return merged;
}
