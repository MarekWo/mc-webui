/**
 * fetchJson() — fetch + JSON parse with one place to explain a non-JSON answer.
 *
 * Call sites used to do `const resp = await fetch(u); const data = await resp.json();`.
 * That parse throws `SyntaxError: Unexpected token '<', "<!DOCTYPE "...` whenever
 * something in front of the app answers instead of the app: a reverse proxy's
 * auth page, a Cloudflare Access login after the session expires, a gateway
 * error page. Some panes printed that exception at the user verbatim (seen
 * 2026-09-08 on an instance published through Cloudflare Zero Trust — the
 * server itself had answered a clean `{"success": false, ...}` 504, but the
 * expired Access session meant the browser never saw it).
 *
 * The return value is the parsed body, so the usual `data.success` / `data.error`
 * checks keep working unchanged. Anything that goes wrong before that is
 * reported in the same shape the API itself uses, so callers need no new branch:
 *
 *   { success: false, error: <translated sentence>, http_status, non_json|offline }
 *
 * An error the API itself sent as JSON is passed through untouched, keeping the
 * server's own message ("No reply from repeater within 10s" and friends).
 */
async function fetchJson(url, options) {
    let resp;
    try {
        resp = await fetch(url, options);
    } catch (e) {
        // Connection refused/dropped, DNS, TLS, or a service worker that
        // answered nothing. No status to report.
        return { success: false, offline: true, error: t('common.network_error') };
    }

    let text;
    try {
        text = await resp.text();
    } catch (e) {
        return { success: false, http_status: resp.status, error: t('common.network_error') };
    }

    if (text === '') {
        // 204, or an error with no body at all
        if (resp.ok) return { success: true, http_status: resp.status };
        return {
            success: false,
            non_json: true,
            http_status: resp.status,
            error: t('common.error.not_json', { status: resp.status }),
        };
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        // 401/403 is the signature of a login gate in front of the app; other
        // statuses read as a gateway or a wrong URL. Either way the body is a
        // web page, and showing its parse error helps nobody.
        const authGate = resp.status === 401 || resp.status === 403;
        console.error(`fetchJson(${url}): HTTP ${resp.status}, body is not JSON:`,
                      text.slice(0, 120));
        return {
            success: false,
            non_json: true,
            http_status: resp.status,
            error: t(authGate ? 'common.error.not_json_auth' : 'common.error.not_json',
                     { status: resp.status }),
        };
    }
}

window.fetchJson = fetchJson;
