import assert from "node:assert";
import dedent from "ts-dedent";
import { fetch } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUDFLARE_ACCOUNT_ID } from "./helpers/account-id";
import { WranglerE2ETestHelper } from "./helpers/e2e-wrangler-test";
import { generateResourceName } from "./helpers/generate-resource-name";
import { normalizeOutput } from "./helpers/normalize";
import { retry } from "./helpers/retry";

const TIMEOUT = 50_000;
const normalize = (str: string) =>
	normalizeOutput(str, {
		[CLOUDFLARE_ACCOUNT_ID]: "CLOUDFLARE_ACCOUNT_ID",
	}).replaceAll(/^Author:.*$/gm, "Author:      person@example.com");

describe("deployments", { timeout: TIMEOUT }, () => {
	const workerName = generateResourceName();
	const helper = new WranglerE2ETestHelper();
	let deployedUrl: string;

	it("deploys a Worker", async () => {
		await helper.seed({
			"wrangler.toml": dedent`
						name = "${workerName}"
						main = "src/index.ts"
						compatibility_date = "2023-01-01"
						`,
			"src/index.ts": dedent`
						export default {
							fetch(request) {
								return new Response("Hello World!")
							}
						}`,
			"package.json": dedent`
						{
							"name": "${workerName}",
							"version": "0.0.0",
							"private": true
						}
						`,
		});

		const output = await helper.run(`wrangler deploy`);

		const match = output.stdout.match(
			/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
		);
		assert(match?.groups);
		deployedUrl = match.groups.url;

		const { text } = await retry(
			(s) => s.status !== 200,
			async () => {
				const r = await fetch(deployedUrl);
				return { text: await r.text(), status: r.status };
			}
		);
		expect(text).toMatchInlineSnapshot('"Hello World!"');
	});

	it("lists 1 deployment", async () => {
		const output = await helper.run(`wrangler deployments list`);

		expect(normalize(output.stdout)).toMatchInlineSnapshot(`
			"Created:     TIMESTAMP
			Author:      person@example.com
			Source:      Upload
			Message:     Automatic deployment on upload.
			Version(s):  (100%) 00000000-0000-0000-0000-000000000000
			                 Created:  TIMESTAMP
			                     Tag:  -
			                 Message:  -"
		`);
	});

	it("modifies & deploys a Worker", async () => {
		await helper.seed({
			"src/index.ts": dedent`
        export default {
          fetch(request) {
            return new Response("Updated Worker!")
          }
        }`,
		});
		const output = await helper.run(`wrangler deploy`);

		const match = output.stdout.match(
			/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
		);
		assert(match?.groups);
		deployedUrl = match.groups.url;

		const { text } = await retry(
			(s) => s.status !== 200 || s.text === "Hello World!",
			async () => {
				const r = await fetch(deployedUrl);
				return { text: await r.text(), status: r.status };
			}
		);
		expect(text).toMatchInlineSnapshot('"Updated Worker!"');
	});

	it("lists 2 deployments", async () => {
		const dep = await helper.run(`wrangler deployments list`);
		expect(normalize(dep.stdout)).toMatchInlineSnapshot(`
			"Created:     TIMESTAMP
			Author:      person@example.com
			Source:      Upload
			Message:     Automatic deployment on upload.
			Version(s):  (100%) 00000000-0000-0000-0000-000000000000
			                 Created:  TIMESTAMP
			                     Tag:  -
			                 Message:  -
			Created:     TIMESTAMP
			Author:      person@example.com
			Source:      Unknown (deployment)
			Message:     -
			Version(s):  (100%) 00000000-0000-0000-0000-000000000000
			                 Created:  TIMESTAMP
			                     Tag:  -
			                 Message:  -"
		`);
	});

	it("rolls back", async () => {
		const output = await helper.run(
			`wrangler rollback --message "A test message"`
		);
		expect(normalize(output.stdout)).toMatchInlineSnapshot(`
			"├ Fetching latest deployment
			│
			├ Your current deployment has 1 version(s):
			│
			│ (100%) 00000000-0000-0000-0000-000000000000
			│       Created:  TIMESTAMP
			│           Tag:  -
			│       Message:  -
			│
			├ Finding latest stable Worker Version to rollback to
			│
			│
			? Please provide an optional message for this rollback (120 characters max)
			🤖 Using default value in non-interactive context: A test message
			│
			├  WARNING  You are about to rollback to Worker Version 00000000-0000-0000-0000-000000000000.
			│ This will immediately replace the current deployment and become the active deployment across all your deployed triggers.
			│ However, your local development environment will not be affected by this rollback.
			│ Rolling back to a previous deployment will not rollback any of the bound resources (Durable Object, D1, R2, KV, etc).
			│
			│ (100%) 00000000-0000-0000-0000-000000000000
			│       Created:  TIMESTAMP
			│           Tag:  -
			│       Message:  -
			│
			? Are you sure you want to deploy this Worker Version to 100% of traffic?
			🤖 Using fallback value in non-interactive context: yes
			Performing rollback...
			│
			╰  SUCCESS  Worker Version 00000000-0000-0000-0000-000000000000 has been deployed to 100% of traffic.
			Current Version ID: 00000000-0000-0000-0000-000000000000"
		`);
	});

	it("lists deployments", async () => {
		const dep = await helper.run(`wrangler deployments list`);
		expect(normalize(dep.stdout)).toMatchInlineSnapshot(`
			"Created:     TIMESTAMP
			Author:      person@example.com
			Source:      Upload
			Message:     Automatic deployment on upload.
			Version(s):  (100%) 00000000-0000-0000-0000-000000000000
			                 Created:  TIMESTAMP
			                     Tag:  -
			                 Message:  -
			Created:     TIMESTAMP
			Author:      person@example.com
			Source:      Unknown (deployment)
			Message:     -
			Version(s):  (100%) 00000000-0000-0000-0000-000000000000
			                 Created:  TIMESTAMP
			                     Tag:  -
			                 Message:  -
			Created:     TIMESTAMP
			Author:      person@example.com
			Source:      Unknown (deployment)
			Message:     A test message
			Version(s):  (100%) 00000000-0000-0000-0000-000000000000
			                 Created:  TIMESTAMP
			                     Tag:  -
			                 Message:  -"
		`);
	});
});

type AssetTestCase = {
	path: string;
	content?: string;
	redirect?: string;
};
function generateInitialAssets(workerName: string) {
	return {
		"public/index.html": dedent`
			<h1>index.html</h1>`,
		"public/[boop].html": dedent`
			<h1>[boop].html</h1>`,
		"public/404.html": dedent`
			<h1>404.html</h1>`,
		"package.json": dedent`
			{
				"name": "${workerName}",
				"version": "0.0.0",
				"private": true
			}`,
	};
}

const checkAssets = async (testCases: AssetTestCase[], deployedUrl: string) => {
	for (const testCase of testCases) {
		await vi.waitFor(
			async () => {
				const r = await fetch(new URL(testCase.path, deployedUrl));
				const text = await r.text();
				const url = r.url;

				if (testCase.content) {
					expect(text).toContain(testCase.content);
				}
				if (testCase.redirect) {
					expect(new URL(url).pathname).toEqual(
						new URL(testCase.redirect, deployedUrl).pathname
					);
				} else {
					expect(new URL(url).pathname).toEqual(
						new URL(testCase.path, deployedUrl).pathname
					);
				}
			},
			{ interval: 1_000, timeout: 40_000 }
		);
	}
};

describe("Workers + Assets deployment", () => {
	const helper = new WranglerE2ETestHelper();
	let deployedUrl: string | undefined;

	describe("Workers", () => {
		let workerName: string;

		beforeEach(() => {
			// deploy a new user Worker in each test
			workerName = generateResourceName();
		});

		afterEach(async () => {
			// clean up user Worker after each test
			await helper.run(`wrangler delete`);
		});

		it("deploys a Workers + Assets project with assets only", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
							name = "${workerName}"
							compatibility_date = "2023-01-01"
							[assets]
							directory = "public"
					`,
				...generateInitialAssets(workerName),
			});

			// deploy user Worker && verify output
			const output = await helper.run(`wrangler deploy`);
			const normalizedStdout = normalize(output.stdout);

			expect(normalizedStdout).toEqual(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir
🌀 Starting asset upload...
🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html
Uploaded 1 of 3 assets
Uploaded 2 of 3 assets
Uploaded 3 of 3 assets
✨ Success! Uploaded 3 files (TIMINGS)
Total Upload: xx KiB / gzip: xx KiB
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
Deployed tmp-e2e-worker-00000000-0000-0000-0000-000000000000 triggers (TIMINGS)
  https://tmp-e2e-worker-00000000-0000-0000-0000-000000000000.SUBDOMAIN.workers.dev
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				// Tests html_handling = "auto_trailing_slash" (default):
				{
					path: "/",
					content: "<h1>index.html</h1>",
				},
				{
					path: "/index.html",
					content: "<h1>index.html</h1>",
					redirect: "/",
				},
				{
					path: "/[boop]",
					content: "<h1>[boop].html</h1>",
					redirect: "/%5Bboop%5D",
				},
			];
			await checkAssets(testCases, deployedUrl);

			// Test 404 handling:
			// even though 404.html has been uploaded, because not_found_handling is set to "none"
			// we expect to get an empty response
			const { text } = await retry(
				(s) => s.status !== 404,
				async () => {
					const r = await fetch(new URL("/try-404", deployedUrl));
					const temp = { text: await r.text(), status: r.status };
					return temp;
				}
			);
			expect(text).toBeFalsy();
		});

		it("deploys a Worker with static assets and user Worker", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
							name = "${workerName}"
							main = "src/index.ts"
							compatibility_date = "2023-01-01"
							[assets]
							directory = "public"
							binding = "ASSETS"
							html_handling = "none"
							not_found_handling = "404-page"
					`,
				"src/index.ts": dedent`
							export default {
								async fetch(request, env) {
									const url = new URL(request.url);
									if (url.pathname === "/binding") {
										return await env.ASSETS.fetch(new URL("index.html", request.url));
									} else if (url.pathname === "/try-404") {
										return await env.ASSETS.fetch(request.url);
									}
									return new Response("Hello World!")
								}
							}`,
				...generateInitialAssets(workerName),
			});

			// deploy user Worker && verify output
			const output = await helper.run(`wrangler deploy`);
			const normalizedStdout = normalize(output.stdout);

			expect(normalizedStdout).toContain(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir
🌀 Starting asset upload...
🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html
Uploaded 1 of 3 assets
Uploaded 2 of 3 assets
Uploaded 3 of 3 assets
✨ Success! Uploaded 3 files (TIMINGS)
Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding            Resource
env.ASSETS         Assets
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
Deployed tmp-e2e-worker-00000000-0000-0000-0000-000000000000 triggers (TIMINGS)
  https://tmp-e2e-worker-00000000-0000-0000-0000-000000000000.SUBDOMAIN.workers.dev
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				// because html handling has now been set to "none", only exact matches will be served
				{
					path: "/index.html",
					content: "<h1>index.html</h1>",
				},
				// 404s should fall through to the user worker, and "/" is not an exact match
				// so we should expect the UW response
				{ path: "/", content: "Hello World!" },
				{
					path: "/binding",
					content: "<h1>index.html</h1>",
				},
				{
					path: "/worker",
					content: "Hello World!",
				},
			];
			await checkAssets(testCases, deployedUrl);

			// unlike before, not_found_handling has been set to "404-page" instead of the default "none"
			// note that with a user worker, the request must be passed back to the asset worker via the ASSET binding
			// in order to return the 404 page
			const { text } = await retry(
				(s) => s.status !== 404,
				async () => {
					const r = await fetch(new URL("/try-404", deployedUrl));
					const temp = { text: await r.text(), status: r.status };
					return temp;
				}
			);
			expect(text).toContain("<h1>404.html</h1>");
		});

		it("deploys a Workers + Assets project with helpful debug logs", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
					name = "${workerName}"
					compatibility_date = "2023-01-01"
					[assets]
					directory = "public"
				`,
				...generateInitialAssets(workerName),
			});

			// deploy user Worker && verify output
			const output = await helper.run(`wrangler deploy`, {
				debug: true,
			});
			const normalizedStdout = normalize(output.stdout);

			expect(normalizedStdout).toContain(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir`);
			// turns out these files are read in a diff order in Windows
			// therefore asserting on each file individually :sigh:
			expect(normalizedStdout).toContain("/404.html");
			expect(normalizedStdout).toContain("/index.html");
			expect(normalizedStdout).toContain("/[boop].html");
			expect(normalizedStdout).toContain("🌀 Starting asset upload...");
			expect(normalizedStdout)
				.toContain(`🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html`);
			expect(normalizedStdout).toContain("Uploaded 1 of 3 assets");
			expect(normalizedStdout).toContain("Uploaded 2 of 3 assets");
			expect(normalizedStdout).toContain("Uploaded 3 of 3 assets");
			// since we can't guarantee the order in which the files are uploaded,
			// we need to check the listing of the uploaded files separately
			expect(normalizedStdout).toContain("✨ /[boop].html");
			expect(normalizedStdout).toContain("✨ /index.html");
			expect(normalizedStdout).toContain("✨ /404.html");
			expect(normalizedStdout).toContain(
				"✨ Success! Uploaded 3 files (TIMINGS)"
			);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				// Tests html_handling = "auto_trailing_slash" (default):
				{
					path: "/",
					content: "<h1>index.html</h1>",
				},
				{
					path: "/index.html",
					content: "<h1>index.html</h1>",
					redirect: "/",
				},
				{
					path: "/[boop]",
					content: "<h1>[boop].html</h1>",
					redirect: "/%5Bboop%5D",
				},
			];
			await checkAssets(testCases, deployedUrl);

			// Test 404 handling:
			// even though 404.html has been uploaded, because not_found_handling is set to "none"
			// we expect to get an empty response
			const { text } = await retry(
				(s) => s.status !== 404,
				async () => {
					const r = await fetch(new URL("/try-404", deployedUrl));
					const temp = { text: await r.text(), status: r.status };
					return temp;
				}
			);
			expect(text).toBeFalsy();
		});

		it("runs the user Worker ahead of matching assets when run_worker_first = true", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
							name = "${workerName}"
							main = "src/index.ts"
							compatibility_date = "2023-01-01"
							[assets]
							directory = "public"
							binding = "ASSETS"
							html_handling = "none"
							not_found_handling = "404-page"
							run_worker_first = true
					`,
				"src/index.ts": dedent`
							export default {
								async fetch(request, env) {
									return new Response("Hello World from User Worker!")
								}
							}`,
				...generateInitialAssets(workerName),
			});

			// deploy user Worker && verify output
			const output = await helper.run(`wrangler deploy`);
			const normalizedStdout = normalize(output.stdout);

			expect(normalizedStdout).toContain(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir
🌀 Starting asset upload...
🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html
Uploaded 1 of 3 assets
Uploaded 2 of 3 assets
Uploaded 3 of 3 assets
✨ Success! Uploaded 3 files (TIMINGS)
Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding            Resource
env.ASSETS         Assets
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
Deployed tmp-e2e-worker-00000000-0000-0000-0000-000000000000 triggers (TIMINGS)
  https://tmp-e2e-worker-00000000-0000-0000-0000-000000000000.SUBDOMAIN.workers.dev
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				{
					path: "/index.html",
					content: "Hello World from User Worker!",
				},
				{
					path: "/",
					content: "Hello World from User Worker!",
				},
				{
					path: "/worker",
					content: "Hello World from User Worker!",
				},
			];
			await checkAssets(testCases, deployedUrl);
		});
	});

	describe("Workers for Platforms", () => {
		let dispatchNamespaceName: string;
		let dispatchWorkerName: string;
		let workerName: string;

		beforeEach(async () => {
			// deploy a new user Worker in each test
			workerName = generateResourceName();

			// set up a new dispatch Worker in each test
			dispatchNamespaceName = generateResourceName("dispatch");
			dispatchWorkerName = generateResourceName();

			await helper.seed({
				"dispatch-worker/wrangler.toml": dedent`
							name = "${dispatchWorkerName}"
							main = "./src/index.js"
							compatibility_date = "2023-01-01"

							[[dispatch_namespaces]]
							binding = "DISPATCH"
							namespace = "${dispatchNamespaceName}"
					`,
				"dispatch-worker/src/index.js": dedent`
					export default {
						async fetch(request, env, ctx) {
							const stub = env.DISPATCH.get("${workerName}");
							return stub.fetch(request);
						}
					}
				`,
			});
		});

		afterEach(async () => {
			// clean up dispatch Worker
			await helper.run(`wrangler delete -c dispatch-worker/wrangler.toml`);
			await helper.run(
				`wrangler dispatch-namespace delete ${dispatchNamespaceName}`
			);
		});

		it("deploys a Workers + Assets project with assets only", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
							name = "${workerName}"
							compatibility_date = "2023-01-01"
							[assets]
							directory = "public"
					`,
				...generateInitialAssets(workerName),
			});

			// create a dispatch namespace && verify output
			let output = await helper.run(
				`wrangler dispatch-namespace create ${dispatchNamespaceName}`
			);
			let normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toContain(
				`Created dispatch namespace "tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000" with ID "00000000-0000-0000-0000-000000000000"`
			);

			// upload user Worker to the dispatch namespace && verify output
			output = await helper.run(
				`wrangler deploy --dispatch-namespace ${dispatchNamespaceName}`
			);
			normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toEqual(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir
🌀 Starting asset upload...
🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html
Uploaded 1 of 3 assets
Uploaded 2 of 3 assets
Uploaded 3 of 3 assets
✨ Success! Uploaded 3 files (TIMINGS)
Total Upload: xx KiB / gzip: xx KiB
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
  Dispatch Namespace: tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			// deploy dispatch Worker && verify output
			output = await helper.run(
				`wrangler deploy -c dispatch-worker/wrangler.toml`
			);
			normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toEqual(`Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding                                                                   Resource
env.DISPATCH (tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000)      Dispatch Namespace
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
Deployed tmp-e2e-worker-00000000-0000-0000-0000-000000000000 triggers (TIMINGS)
  https://tmp-e2e-worker-00000000-0000-0000-0000-000000000000.SUBDOMAIN.workers.dev
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				// Tests html_handling = "auto_trailing_slash" (default):
				{
					path: "/",
					content: "<h1>index.html</h1>",
				},
				{
					path: "/index.html",
					content: "<h1>index.html</h1>",
					redirect: "/",
				},
				{
					path: "/[boop]",
					content: "<h1>[boop].html</h1>",
					redirect: "/%5Bboop%5D",
				},
			];
			await checkAssets(testCases, deployedUrl);

			// Test 404 handling:
			// even though 404.html has been uploaded, because not_found_handling is set to "none"
			// we expect to get an empty response
			const { text } = await retry(
				(s) => s.status !== 404,
				async () => {
					const r = await fetch(new URL("/try-404", deployedUrl));
					const temp = { text: await r.text(), status: r.status };
					return temp;
				}
			);
			expect(text).toBeFalsy();
		});

		it("deploys a Worker with static assets and user Worker", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
							name = "${workerName}"
							main = "src/index.ts"
							compatibility_date = "2023-01-01"
							[assets]
							directory = "public"
							binding = "ASSETS"
							html_handling = "none"
							not_found_handling = "404-page"
					`,
				"src/index.ts": dedent`
							export default {
								async fetch(request, env) {
									const url = new URL(request.url);
									if (url.pathname === "/binding") {
										return await env.ASSETS.fetch(new URL("index.html", request.url));
									} else if (url.pathname === "/try-404") {
										return await env.ASSETS.fetch(request.url);
									}
									return new Response("Hello World!")
								}
							}`,
				...generateInitialAssets(workerName),
			});

			// create a dispatch namespace && verify output
			let output = await helper.run(
				`wrangler dispatch-namespace create ${dispatchNamespaceName}`
			);
			let normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toContain(
				`Created dispatch namespace "tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000" with ID "00000000-0000-0000-0000-000000000000"`
			);

			// upload user Worker to the dispatch namespace && verify output
			output = await helper.run(
				`wrangler deploy --dispatch-namespace ${dispatchNamespaceName}`
			);
			normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toContain(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir
🌀 Starting asset upload...
🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html
Uploaded 1 of 3 assets
Uploaded 2 of 3 assets
Uploaded 3 of 3 assets
✨ Success! Uploaded 3 files (TIMINGS)
Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding            Resource
env.ASSETS         Assets
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
  Dispatch Namespace: tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			// deploy dispatch Worker && verify output
			output = await helper.run(
				`wrangler deploy -c dispatch-worker/wrangler.toml`
			);
			normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toEqual(`Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding                                                                   Resource
env.DISPATCH (tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000)      Dispatch Namespace
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
Deployed tmp-e2e-worker-00000000-0000-0000-0000-000000000000 triggers (TIMINGS)
  https://tmp-e2e-worker-00000000-0000-0000-0000-000000000000.SUBDOMAIN.workers.dev
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				// because html handling has now been set to "none", only exact matches will be served
				{
					path: "/index.html",
					content: "<h1>index.html</h1>",
				},
				// 404s should fall through to the user worker, and "/" is not an exact match
				// so we should expect the UW response
				{ path: "/", content: "Hello World!" },
				{
					path: "/binding",
					content: "<h1>index.html</h1>",
				},
				{
					path: "/worker",
					content: "Hello World!",
				},
			];
			await checkAssets(testCases, deployedUrl);

			// unlike before, not_found_handling has been set to "404-page"
			// instead of the default "none"
			// note that with a user Worker, the request must be passed back to
			// the asset worker via the ASSET binding in order to return the 404
			// page
			const { text } = await retry(
				(s) => s.status !== 404,
				async () => {
					const r = await fetch(new URL("/try-404", deployedUrl));
					const temp = { text: await r.text(), status: r.status };
					return temp;
				}
			);
			expect(text).toContain("<h1>404.html</h1>");
		});

		it("runs the user Worker ahead of matching assets when run_worker_first = true", async () => {
			await helper.seed({
				"wrangler.toml": dedent`
							name = "${workerName}"
							main = "src/index.ts"
							compatibility_date = "2023-01-01"
							[assets]
							directory = "public"
							binding = "ASSETS"
							html_handling = "none"
							not_found_handling = "404-page"
							run_worker_first = true
					`,
				"src/index.ts": dedent`
							export default {
								async fetch(request, env) {
									return new Response("Hello World from User Worker!")
								}
							}`,
				...generateInitialAssets(workerName),
			});

			// create a dispatch namespace && verify output
			let output = await helper.run(
				`wrangler dispatch-namespace create ${dispatchNamespaceName}`
			);
			let normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toContain(
				`Created dispatch namespace "tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000" with ID "00000000-0000-0000-0000-000000000000"`
			);

			// upload user Worker to the dispatch namespace && verify output
			output = await helper.run(
				`wrangler deploy --dispatch-namespace ${dispatchNamespaceName}`
			);
			normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toContain(`🌀 Building list of assets...
✨ Read 3 files from the assets directory /tmpdir
🌀 Starting asset upload...
🌀 Found 3 new or modified static assets to upload. Proceeding with upload...
+ /404.html
+ /index.html
+ /[boop].html
Uploaded 1 of 3 assets
Uploaded 2 of 3 assets
Uploaded 3 of 3 assets
✨ Success! Uploaded 3 files (TIMINGS)
Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding            Resource
env.ASSETS         Assets
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
  Dispatch Namespace: tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			// deploy dispatch Worker && verify output
			output = await helper.run(
				`wrangler deploy -c dispatch-worker/wrangler.toml`
			);
			normalizedStdout = normalize(output.stdout);
			expect(normalizedStdout).toEqual(`Total Upload: xx KiB / gzip: xx KiB
Your Worker has access to the following bindings:
Binding                                                                   Resource
env.DISPATCH (tmp-e2e-dispatch-00000000-0000-0000-0000-000000000000)      Dispatch Namespace
Uploaded tmp-e2e-worker-00000000-0000-0000-0000-000000000000 (TIMINGS)
Deployed tmp-e2e-worker-00000000-0000-0000-0000-000000000000 triggers (TIMINGS)
  https://tmp-e2e-worker-00000000-0000-0000-0000-000000000000.SUBDOMAIN.workers.dev
Current Version ID: 00000000-0000-0000-0000-000000000000`);

			const match = output.stdout.match(
				/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
			);
			assert(match?.groups);
			deployedUrl = match.groups.url;

			const testCases: AssetTestCase[] = [
				{
					path: "/index.html",
					content: "Hello World from User Worker!",
				},
				{
					path: "/",
					content: "Hello World from User Worker!",
				},
				{
					path: "/worker",
					content: "Hello World from User Worker!",
				},
			];
			await checkAssets(testCases, deployedUrl);
		});
	});
	describe("durable objects [containers]", () => {
		const workerName = generateResourceName();
		beforeEach(async () => {
			await helper.seed({
				"wrangler.toml": dedent`
						name = "${workerName}"
						main = "src/index.ts"
						compatibility_date = "2023-01-01"

						[durable_objects]
						bindings = [
							{ name = "MY_DO", class_name = "MyDurableObject" }
						]

						[[containers]]
						name = "e2e-test-${workerName}"
						class_name = "MyDurableObject"
						image = "registry.cloudchamber.cfdata.org/e2e-test:1.0"
						max_instances = 1

						[[migrations]]
						tag = "v1"
						new_sqlite_classes = ["MyDurableObject"]
				`,
				"src/index.ts": dedent`
              export default {
                async fetch(req, env) {
                  const url = new URL(req.url)
                  if (url.pathname === "/do") {
                      const id = env.MY_DO.idFromName(url.pathname);
                      const stub = env.MY_DO.get(id);
                      try {
                      	return await stub.fetch(req);
                      } catch (err) {
                        return new Response("Error fetching from stub: " + err.message, { status: 400 });
                      }
                  }

                  return new Response("not found", { status: 404 });
								},
							};

              export class MyDurableObject implements DurableObject {
                constructor(ctx) {
                  this.ctx = ctx;
                }

                async fetch(_: Request) {
                  if (!this.ctx.container) {
                    return new Response('this.ctx.container not defined', { status: 500 });
                  }

                  if (!this.ctx.container.running) {
                    this.ctx.container.start();
                    this.monitor = this.ctx.container.monitor();
                  }

                  return this.ctx.container.getTcpPort(80).fetch(new Request("http://foo"));
                }
              }`,
			});
		});

		it(
			"can fetch DO container",
			{ timeout: 60 * 3 * 1000, retry: 3 },
			async () => {
				const output = await helper.run(`wrangler deploy`);

				const match = output.stdout.match(
					/(?<url>https:\/\/tmp-e2e-.+?\..+?\.workers\.dev)/
				);
				assert(match?.groups);
				const matchApplicationId = output.stdout.match(
					/([(]Application ID: (?<applicationId>.+?)[)])/
				);
				assert(matchApplicationId?.groups);
				const url = match.groups.url;
				try {
					await vi.waitFor(
						async () => {
							const response = await fetch(`${url}/do`);
							if (!response.ok) {
								throw new Error(
									"Durable object transient error: " + (await response.text())
								);
							}

							expect(await response.text()).toEqual("hello from container");
						},

						// big timeout for containers
						// (3m)
						{ timeout: 60 * 3 * 1000, interval: 1000 }
					);
				} finally {
					await helper.run(
						`wrangler containers delete ${matchApplicationId.groups.applicationId}`
					);
				}
			}
		);
	});
});
