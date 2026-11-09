import { type Browser, expect, type Page, test } from "@playwright/test";

// What the page exposes on window for measuring (see client/src/globals.d.ts).
// Only the fields this test reads are described.
interface NetHandle {
  latest: { entities: { id: number; kind: string; x: number; y: number }[] } | null;
  predictor: { netId: number };
}
declare global {
  interface Window {
    __net?: NetHandle;
  }
}

async function enter(browser: Browser, roomName: string, pilot: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.fill("#name", pilot);
  await page
    .locator("#rooms li", { hasText: roomName })
    .getByRole("button", { name: "Join" })
    .click();
  // the first snapshot has arrived: the ship exists and the match runs
  await page.waitForFunction(() => window.__net?.latest != null);
  return page;
}

// where this page sees the OTHER player's ship, in arena units
const otherShip = (page: Page) =>
  page.evaluate(() => {
    const net = window.__net;
    const ship = net?.latest?.entities.find(
      (e) => e.kind === "ship" && e.id !== net.predictor.netId,
    );
    return ship ? { x: ship.x, y: ship.y } : null;
  });

test("two browsers share a room: roster, movement seen across, chat", async ({
  browser,
  request,
}) => {
  const created = await request.post("/api/rooms", {
    data: { name: "e2e arena", arena: "duel" },
  });
  expect(created.status()).toBe(201);

  const ann = await enter(browser, "e2e arena", "Ann");
  const bob = await enter(browser, "e2e arena", "Bob");

  // both see both players in the roster
  await expect(ann.locator(".chat .players li")).toHaveCount(2);
  await expect(bob.locator(".chat .players li")).toHaveCount(2);
  await expect(ann.locator(".chat .players")).toContainText("Ann (you)");
  await expect(bob.locator(".chat .players")).toContainText("Bob (you)");

  // Ann thrusts and turns; Bob must see her ship move within 500 ms
  await expect.poll(() => otherShip(bob)).not.toBeNull();
  const before = await otherShip(bob);
  const started = Date.now();
  await ann.keyboard.down("ArrowUp");
  await ann.keyboard.down("ArrowRight");

  let seenAfterMs = -1;
  await expect
    .poll(
      async () => {
        const now = await otherShip(bob);
        const moved = before && now ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
        if (moved > 3 && seenAfterMs < 0) seenAfterMs = Date.now() - started;
        return moved;
      },
      { timeout: 2000, intervals: [50] },
    )
    .toBeGreaterThan(3);
  await ann.keyboard.up("ArrowUp");
  await ann.keyboard.up("ArrowRight");
  expect(seenAfterMs).toBeGreaterThanOrEqual(0);
  expect(seenAfterMs).toBeLessThan(500);

  // a chat line from Ann reaches Bob
  await ann.locator(".chat .line").fill("hello from Ann");
  await ann.locator(".chat .line").press("Enter");
  await expect(bob.locator(".chat .log")).toContainText("Ann: hello from Ann");
  await expect(ann.locator(".chat .log")).toContainText("Ann: hello from Ann");
});
