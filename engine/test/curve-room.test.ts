import { expect, test } from "bun:test";
import { curveRoomZats } from "../src/dbc/room";

test("room is 95% of what is left under the threshold", () => {
  expect(curveRoomZats(666_666_666n, 515_000_000n)).toBe(144_083_332n);
});

test("a full or overfull curve has no room (partial-fill fills end 1 unit over the threshold)", () => {
  expect(curveRoomZats(666_666_666n, 666_666_666n)).toBe(0n);
  expect(curveRoomZats(666_666_666n, 666_666_667n)).toBe(0n);
});

test("an empty curve has room for most of the threshold", () => {
  expect(curveRoomZats(666_666_666n, 0n)).toBe(633_333_332n);
});
