import assert from "node:assert/strict";
import { betError, clearActiveTable, entryMode, readActiveTable, rejoinNotice, saveActiveTable } from "./session";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key)
  }
});

saveActiveTable({ tableId: "t1", mode: "live", groupId: "g1" });
assert.equal(entryMode(true), "table");
assert.equal(rejoinNotice(readActiveTable(), { id: "t1", title: "Friday Night" }), "Rejoined Friday Night — your seat is held.");

assert.equal(entryMode(false), "entry");
assert.equal(rejoinNotice(readActiveTable(), null), null);
assert.equal(rejoinNotice(readActiveTable(), { id: "other", title: "Gone" }), null);

clearActiveTable();
assert.equal(readActiveTable(), null);
assert.equal(rejoinNotice(readActiveTable(), { id: "t1", title: "Friday Night" }), null);

assert.equal(betError(5, 1, 10), null);
assert.equal(betError(0, 1, 10), "Enter a bet amount");
assert.equal(betError(20, 1, 10), "Bet must be between 1 and 10");
assert.equal(betError(Number.NaN, 1, 100), "Enter a bet amount");

console.log("session tests passed");
