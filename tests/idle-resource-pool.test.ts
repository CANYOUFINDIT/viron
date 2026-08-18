import { describe, expect, it, vi } from "vitest";
import { IdleResourcePool } from "../src/shared/idle-resource-pool.js";

describe("IdleResourcePool", () => {
  it("reuses released resources for the same key", async () => {
    const dispose = vi.fn();
    const create = vi.fn(async () => ({ id: 1, usable: true }));
    const pool = new IdleResourcePool({ idleMs: 60_000, dispose, usable: (resource) => resource.usable });
    const first = await pool.acquire("connection", create);
    expect(first.reused).toBe(false);
    await first.release();
    const second = await pool.acquire("connection", create);
    expect(second.reused).toBe(true);
    expect(second.resource).toBe(first.resource);
    expect(create).toHaveBeenCalledTimes(1);
    await second.release();
    await pool.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps active resources isolated and disposes them immediately when invalidated", async () => {
    const disposed: number[] = [];
    let nextId = 0;
    const pool = new IdleResourcePool<{ id: number }>({ dispose: (resource) => { disposed.push(resource.id); } });
    const first = await pool.acquire("connection", async () => ({ id: ++nextId }));
    const second = await pool.acquire("connection", async () => ({ id: ++nextId }));
    expect(second.resource.id).not.toBe(first.resource.id);
    await pool.invalidate((key) => key === "connection");
    expect(pool.stats()).toEqual({ total: 0, active: 0, idle: 0 });
    expect(disposed.sort()).toEqual([1, 2]);
    await Promise.all([first.release(), second.release()]);
    expect(disposed.sort()).toEqual([1, 2]);
    expect(pool.stats().total).toBe(0);
    await pool.close();
  });

  it("expires idle resources after the configured lifetime", async () => {
    let now = 1_000;
    const dispose = vi.fn();
    const create = vi.fn(async () => ({ id: 1 }));
    const pool = new IdleResourcePool({ idleMs: 1_000, now: () => now, dispose });
    const first = await pool.acquire("connection", create);
    await first.release();
    now = 2_001;
    const second = await pool.acquire("connection", create);
    expect(second.reused).toBe(false);
    expect(create).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    await second.release();
    await pool.close();
  });

  it("disposes a connection that finishes opening after invalidation", async () => {
    let finishCreate: ((resource: { id: number }) => void) | undefined;
    let createStarted: (() => void) | undefined;
    const disposed: number[] = [];
    const pool = new IdleResourcePool<{ id: number }>({ dispose: (resource) => { disposed.push(resource.id); } });
    const started = new Promise<void>((resolve) => { createStarted = resolve; });
    const acquiring = pool.acquire("connection", () => new Promise((resolve) => {
      finishCreate = resolve;
      createStarted?.();
    }));
    await started;

    await pool.invalidate();
    finishCreate?.({ id: 1 });

    await expect(acquiring).rejects.toThrow("建立期间已失效");
    expect(disposed).toEqual([1]);
    expect(pool.stats().total).toBe(0);
    await pool.close();
  });
});
