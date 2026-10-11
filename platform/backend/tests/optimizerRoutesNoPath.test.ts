/**
 * The optimizer routes never tell a browser where the checkout lives.
 *
 * `/api/optimizer/trees` and every 404 used to carry `root`: the absolute path
 * of the optimizer directory on the server's disk. Nothing on the page read it;
 * it simply told any visitor the machine's directory layout.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { optimizerRoutes } from "../src/api/routes/optimizer";

test("optimizer responses carry no server filesystem path", async () => {
  const app = Fastify();
  await app.register(optimizerRoutes);
  await app.ready();
  try {
    const trees = await app.inject({ method: "GET", url: "/api/optimizer/trees" });
    assert.equal(trees.statusCode, 200);
    assert.equal("root" in trees.json(), false, "the tree list still names the server's directory");
    assert.doesNotMatch(trees.body, /\/Users\/|\/home\/|[A-Z]:\\\\/);
    const missing = await app.inject({ method: "GET", url: "/api/optimizer/results?tree=no-such-tree" });
    assert.doesNotMatch(missing.body, /"root"/);
  } finally {
    await app.close();
  }
});
