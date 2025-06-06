import crypto from "node:crypto";
import { URL } from "node:url";
import { fetch } from "undici";
import { fetchResult } from "../cfetch";
import { createWorkerUploadForm } from "../deployment-bundle/create-worker-upload-form";
import { UserError } from "../errors";
import { logger } from "../logger";
import { ParseError, parseJSON } from "../parse";
import { getAccessToken } from "../user/access";
import { isAbortError } from "../utils/isAbortError";
import type { CfWorkerContext } from "../deployment-bundle/worker";
import type { ComplianceConfig } from "../environment-variables/misc-variables";
import type { ApiCredentials } from "../user";
import type { CfWorkerInitWithName } from "./remote";
import type { HeadersInit } from "undici";

/**
 * A Cloudflare account.
 */

export interface CfAccount {
	/**
	 * An API token.
	 *
	 * @link https://api.cloudflare.com/#user-api-tokens-properties
	 */
	apiToken: ApiCredentials;
	/**
	 * An account ID.
	 */
	accountId: string;
}

/**
 * A Preview Session on the edge
 */
export interface CfPreviewSession {
	/**
	 * A randomly generated id for this session
	 */
	id: string;
	/**
	 * A value to use when creating a worker preview under a session
	 */
	value: string;
	/**
	 * The host where the session is available.
	 */
	host: string;
	/**
	 * A websocket url to a DevTools inspector.
	 *
	 * Workers does not have a fully-featured implementation
	 * of the Chrome DevTools protocol, but supports the following:
	 *  * `console.log()` output.
	 *  * `Error` stack traces.
	 *  * `fetch()` events.
	 *
	 * There is no support for breakpoints, but we want to implement
	 * this eventually.
	 *
	 * @link https://chromedevtools.github.io/devtools-protocol/
	 */
	inspectorUrl: URL;
	/**
	 * A url to prewarm the preview session.
	 *
	 * @example
	 * fetch(prewarmUrl, { method: 'POST' })
	 */
	prewarmUrl: URL;
}

/**
 * Session configuration for realish preview. This is sent to the API as the
 * `wrangler-session-config` form data part.
 *
 * Only one of `workers_dev` and `routes` can be specified:
 * * If `workers_dev` is set, the preview will run using a `workers.dev` subdomain.
 * * If `routes` is set, the preview will run using the list of routes provided, which must be under a single zone
 *
 * `minimal_mode` is a flag to tell the API to enable "raw" mode bindings in this session
 */
type CfPreviewMode =
	| {
			workers_dev: true;
			minimal_mode?: boolean;
	  }
	| {
			routes: string[];
			minimal_mode?: boolean;
	  };

/**
 * A preview token.
 */
export interface CfPreviewToken {
	/**
	 * The header value required to trigger a preview.
	 *
	 * @example
	 * const headers = { 'cf-workers-preview-token': value }
	 * const response = await fetch('https://' + host, { headers })
	 */
	value: string;
	/**
	 * The host where the preview is available.
	 */
	host: string;
	/**
	 * A websocket url to a DevTools inspector.
	 *
	 * Workers does not have a fully-featured implementation
	 * of the Chrome DevTools protocol, but supports the following:
	 *  * `console.log()` output.
	 *  * `Error` stack traces.
	 *  * `fetch()` events.
	 *
	 * There is no support for breakpoints, but we want to implement
	 * this eventually.
	 *
	 * @link https://chromedevtools.github.io/devtools-protocol/
	 */
	inspectorUrl: URL;
	/**
	 * A url to prewarm the preview session.
	 *
	 * @example
	 * fetch(prewarmUrl, { method: 'POST',
	 * 	 headers: {
	 *     "cf-workers-preview-token": (preview)token.value,
	 *   }
	 * })
	 */
	prewarmUrl: URL;
}

// URLs are often relative to the zone. Sometimes the base zone
// will be grey-clouded, and so the host must be swapped out for
// the worker route host, which is more likely to be orange-clouded.
// However, this switching should only happen if we're running a zone preview
// rather than a workers.dev preview
function switchHost(
	originalUrl: string,
	host: string | undefined,
	zonePreview: boolean
): URL {
	const url = new URL(originalUrl);
	url.hostname = zonePreview ? host ?? url.hostname : url.hostname;
	return url;
}
/**
 * Generates a preview session token.
 */
export async function createPreviewSession(
	complianceConfig: ComplianceConfig,
	account: CfAccount,
	ctx: CfWorkerContext,
	abortSignal: AbortSignal
): Promise<CfPreviewSession> {
	const { accountId } = account;
	const initUrl = ctx.zone
		? `/zones/${ctx.zone}/workers/edge-preview`
		: `/accounts/${accountId}/workers/subdomain/edge-preview`;

	const { exchange_url } = await fetchResult<{ exchange_url: string }>(
		complianceConfig,
		initUrl,
		undefined,
		undefined,
		abortSignal
	);

	const switchedExchangeUrl = switchHost(
		exchange_url,
		ctx.host,
		!!ctx.zone
	).toString();

	logger.debugWithSanitization(
		"-- START EXCHANGE API REQUEST:",
		` GET ${switchedExchangeUrl}`
	);

	logger.debug("-- END EXCHANGE API REQUEST");
	const exchangeResponse = await fetch(switchedExchangeUrl, {
		signal: abortSignal,
	});
	const bodyText = await exchangeResponse.text();
	logger.debug(
		"-- START EXCHANGE API RESPONSE:",
		exchangeResponse.statusText,
		exchangeResponse.status
	);
	logger.debug("HEADERS:", JSON.stringify(exchangeResponse.headers, null, 2));
	logger.debugWithSanitization("RESPONSE:", bodyText);

	logger.debug("-- END EXCHANGE API RESPONSE");
	try {
		const { inspector_websocket, prewarm, token } = parseJSON(bodyText) as {
			inspector_websocket: string;
			token: string;
			prewarm: string;
		};
		const inspector = new URL(inspector_websocket);
		inspector.searchParams.append("cf_workers_preview_token", token);

		return {
			id: crypto.randomUUID(),
			value: token,
			host: ctx.host ?? inspector.host,
			inspectorUrl: switchHost(inspector.href, ctx.host, !!ctx.zone),
			prewarmUrl: switchHost(prewarm, ctx.host, !!ctx.zone),
		};
	} catch (e) {
		if (!(e instanceof ParseError)) {
			throw e;
		} else {
			throw new UserError(
				`Could not create remote preview session on ${
					ctx.zone
						? ` host \`${ctx.host}\` on zone \`${ctx.zone}\``
						: `your account`
				}.`
			);
		}
	}
}

/**
 * Creates a preview token.
 */
async function createPreviewToken(
	complianceConfig: ComplianceConfig,
	account: CfAccount,
	worker: CfWorkerInitWithName,
	ctx: CfWorkerContext,
	session: CfPreviewSession,
	abortSignal: AbortSignal,
	minimal_mode?: boolean
): Promise<CfPreviewToken> {
	const { value, host, inspectorUrl, prewarmUrl } = session;
	const { accountId } = account;
	const url =
		ctx.env && !ctx.legacyEnv
			? `/accounts/${accountId}/workers/services/${worker.name}/environments/${ctx.env}/edge-preview`
			: `/accounts/${accountId}/workers/scripts/${worker.name}/edge-preview`;

	const mode: CfPreviewMode = ctx.zone
		? {
				routes:
					ctx.routes && ctx.routes.length > 0
						? // extract all the route patterns
							ctx.routes.map((route) => {
								if (typeof route === "string") {
									return route;
								}
								if (route.custom_domain) {
									return `${route.pattern}/*`;
								}
								return route.pattern;
							})
						: // if there aren't any patterns, then just match on all routes
							["*/*"],
				minimal_mode,
			}
		: { workers_dev: true, minimal_mode };

	const formData = createWorkerUploadForm(worker);
	formData.set("wrangler-session-config", JSON.stringify(mode));

	const { preview_token } = await fetchResult<{ preview_token: string }>(
		complianceConfig,
		url,
		{
			method: "POST",
			body: formData,
			headers: {
				"cf-preview-upload-config-token": value,
			},
		},
		undefined,
		abortSignal
	);

	return {
		value: preview_token,
		host:
			ctx.host ??
			(worker.name
				? `${
						worker.name
						// TODO: this should also probably have the env prefix
						// but it doesn't appear to work yet, instead giving us the
						// "There is nothing here yet" screen
						// ctx.env && !ctx.legacyEnv
						//   ? `${ctx.env}.${worker.name}`
						//   : worker.name
					}.${host.split(".").slice(1).join(".")}`
				: host),

		inspectorUrl,
		prewarmUrl,
	};
}

/**
 * A stub to create a Cloudflare Worker preview.
 *
 * @example
 * const {value, host} = await createWorker(init, acct);
 */
export async function createWorkerPreview(
	complianceConfig: ComplianceConfig,
	init: CfWorkerInitWithName,
	account: CfAccount,
	ctx: CfWorkerContext,
	session: CfPreviewSession,
	abortSignal: AbortSignal,
	minimal_mode?: boolean
): Promise<CfPreviewToken> {
	const token = await createPreviewToken(
		complianceConfig,
		account,
		init,
		ctx,
		session,
		abortSignal,
		minimal_mode
	);
	const accessToken = await getAccessToken(token.prewarmUrl.hostname);

	const headers: HeadersInit = { "cf-workers-preview-token": token.value };
	if (accessToken) {
		headers.cookie = `CF_Authorization=${accessToken}`;
	}

	// fire and forget the prewarm call
	fetch(token.prewarmUrl.href, {
		method: "POST",
		signal: abortSignal,
		headers,
	}).then(
		(response) => {
			if (!response.ok) {
				logger.warn("worker failed to prewarm: ", response.statusText);
			}
		},
		(err) => {
			if (isAbortError(err)) {
				logger.warn("worker failed to prewarm: ", err);
			}
		}
	);

	return token;
}
