using System.Net;
using System.Net.Sockets;
using SharedCookbook.Infrastructure.Services;

namespace SharedCookbook.Api.Services;

/// <summary>
/// Defence-in-depth guard on <c>/api/internal/*</c>. The first line of
/// defence is Caddy's <c>@internal</c> matcher that short-circuits
/// external requests with a <c>404</c> before they ever reach Kestrel.
/// This middleware is the second line: should Caddy ever be bypassed —
/// a misconfigured reverse-proxy, a direct connection to the container
/// port, a dev port-forward — we still refuse traffic whose socket
/// <see cref="HttpContext.Connection.RemoteIpAddress"/> does not fall
/// inside the Docker bridge CIDR allowlist.
///
/// The response deliberately mirrors Caddy's behaviour (<c>404</c>, no
/// body) so an external attacker cannot distinguish "endpoint exists
/// but refused" from "endpoint doesn't exist" and probe for it.
///
/// <b>Fail-closed.</b> If the configured allowlist cannot be parsed at
/// startup — truly <em>should never happen</em> because the defaults
/// are baked in, but defence-in-depth — the middleware rejects every
/// request to <c>/api/internal/*</c>. An operator tightening the
/// allowlist via config always picks narrower CIDRs; a broken config
/// must never silently accept everything.
/// </summary>
public sealed class InternalOnlyMiddleware
{
    /// <summary>Route prefix this middleware guards.</summary>
    public const string InternalPathPrefix = "/api/internal";

    /// <summary>
    /// Default CIDR allowlist matching the pinned compose-network subnet
    /// (<c>172.28.0.0/16</c>; see <c>networks.default.ipam</c> in both
    /// <c>docker-compose.yml</c> and <c>docker-compose.prod.yml</c>).
    /// Pinning the subnet at the compose layer AND narrowing the
    /// allowlist to a single range means Docker's default-pool pick
    /// (<c>172.17+</c>) cannot silently land the python-extractor on a
    /// block this middleware rejects. Changing the compose subnet
    /// REQUIRES updating this entry in lockstep. Deployments that need
    /// a different subnet (custom overlay, macvlan, host-networking
    /// sidecar) override the list via <c>InternalOrigin:AllowedCidrs</c>.
    /// <c>127.0.0.0/8</c> + <c>::1/128</c> stay in so health probes,
    /// the test TestServer (when not hitting the reject path), and
    /// manual <c>docker exec curl</c> from the API container itself
    /// still reach the route.
    /// </summary>
    public static readonly string[] DefaultAllowedCidrs =
    {
        "172.28.0.0/16",
        "127.0.0.0/8",
        "::1/128",
    };

    /// <summary>Test-environment bypass header. Tests that legitimately
    /// want to exercise the endpoint's happy path set this to <c>true</c>;
    /// tests that specifically verify the middleware's reject path omit
    /// (or set <c>false</c>) so the production logic runs.</summary>
    public const string TestBypassHeader = "X-Test-Internal-Allow";

    private readonly RequestDelegate _next;
    private readonly ILogger<InternalOnlyMiddleware> _logger;
    private readonly IHostEnvironment _env;
    private readonly CidrRange[] _allowed;
    private readonly bool _allowlistBroken;

    public InternalOnlyMiddleware(
        RequestDelegate next,
        ILogger<InternalOnlyMiddleware> logger,
        IHostEnvironment env,
        IConfiguration config)
    {
        _next = next;
        _logger = logger;
        _env = env;

        var configured = config.GetSection("InternalOrigin:AllowedCidrs")
            .Get<string[]>() ?? DefaultAllowedCidrs;
        var parsed = new List<CidrRange>(configured.Length);
        var anyFailed = false;
        foreach (var cidr in configured)
        {
            if (CidrRange.TryParse(cidr, out var range))
            {
                parsed.Add(range);
            }
            else
            {
                anyFailed = true;
                _logger.LogError(
                    "InternalOnlyMiddleware: failed to parse allowlist CIDR '{Cidr}'. "
                    + "Fail-closed — all /api/internal/* traffic will be rejected.",
                    cidr);
            }
        }
        _allowed = parsed.ToArray();
        _allowlistBroken = anyFailed || parsed.Count == 0;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        if (!path.StartsWithSegments(InternalPathPrefix, StringComparison.OrdinalIgnoreCase))
        {
            await _next(context);
            return;
        }

        // Testing-env opt-in header so the endpoint's business-logic tests
        // don't have to fake the docker bridge IP. The middleware's reject
        // tests omit the header so the production branch still runs.
        if (_env.IsEnvironment("Testing")
            && context.Request.Headers[TestBypassHeader] == "true")
        {
            await _next(context);
            return;
        }

        if (_allowlistBroken)
        {
            await Deny(context, "allowlist-broken");
            return;
        }

        var remote = context.Connection.RemoteIpAddress;
        if (remote is null)
        {
            // No RemoteIpAddress = synthetic transport (TestServer) OR
            // a broken socket. Neither is "proven-internal" — fail
            // closed.
            await Deny(context, "no-remote-ip");
            return;
        }

        if (!IsAllowed(remote))
        {
            await Deny(context, "external-origin");
            return;
        }

        await _next(context);
    }

    private bool IsAllowed(IPAddress remote)
    {
        // Normalise IPv6-mapped IPv4 (::ffff:172.18.0.3) down to its v4
        // form so a single CIDR entry like 172.18.0.0/16 matches both.
        var normalised = remote.IsIPv4MappedToIPv6 ? remote.MapToIPv4() : remote;
        foreach (var range in _allowed)
        {
            if (range.Contains(normalised)) return true;
        }
        return false;
    }

    private async Task Deny(HttpContext context, string reason)
    {
        // SEC-1: Method + Path are user-controlled. Sanitize to neuter
        // any embedded \r\n that would otherwise inject fake adjacent
        // log lines into a tail/cat'd console output. Reason is hard-
        // coded by callers in this file, so it doesn't need sanitizing.
        _logger.LogWarning(
            "InternalOnlyMiddleware rejected request {Method} {Path} from {Remote} (reason={Reason}).",
            LogSanitizer.ForLog(context.Request.Method),
            LogSanitizer.ForLog(context.Request.Path.Value),
            context.Connection.RemoteIpAddress,
            reason);
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        // Match Caddy's `respond 404` — no body, no hints about the
        // endpoint existing.
        await context.Response.CompleteAsync();
    }

    /// <summary>Parsed CIDR range. Stores the network base + mask so
    /// each <see cref="Contains"/> check is two AND-compares on the
    /// raw bytes — no LINQ, no allocations per request.</summary>
    private readonly struct CidrRange
    {
        private readonly byte[] _networkBytes;
        private readonly byte[] _maskBytes;
        private readonly AddressFamily _family;

        private CidrRange(byte[] networkBytes, byte[] maskBytes, AddressFamily family)
        {
            _networkBytes = networkBytes;
            _maskBytes = maskBytes;
            _family = family;
        }

        public static bool TryParse(string raw, out CidrRange range)
        {
            range = default;
            if (string.IsNullOrWhiteSpace(raw)) return false;
            var slash = raw.IndexOf('/');
            if (slash <= 0 || slash == raw.Length - 1) return false;
            var addrPart = raw[..slash];
            var bitsPart = raw[(slash + 1)..];
            if (!IPAddress.TryParse(addrPart, out var addr)) return false;
            if (!int.TryParse(bitsPart,
                    System.Globalization.NumberStyles.Integer,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var bits))
                return false;

            var bytes = addr.GetAddressBytes();
            var totalBits = bytes.Length * 8;
            if (bits < 0 || bits > totalBits) return false;

            var mask = new byte[bytes.Length];
            var remaining = bits;
            for (var i = 0; i < bytes.Length; i++)
            {
                if (remaining >= 8)
                {
                    mask[i] = 0xff;
                    remaining -= 8;
                }
                else if (remaining > 0)
                {
                    mask[i] = (byte)(0xff << (8 - remaining));
                    remaining = 0;
                }
                else
                {
                    mask[i] = 0x00;
                }
            }
            var network = new byte[bytes.Length];
            for (var i = 0; i < bytes.Length; i++)
            {
                network[i] = (byte)(bytes[i] & mask[i]);
            }
            range = new CidrRange(network, mask, addr.AddressFamily);
            return true;
        }

        public bool Contains(IPAddress addr)
        {
            if (addr.AddressFamily != _family) return false;
            var b = addr.GetAddressBytes();
            if (b.Length != _networkBytes.Length) return false;
            for (var i = 0; i < b.Length; i++)
            {
                if ((b[i] & _maskBytes[i]) != _networkBytes[i]) return false;
            }
            return true;
        }
    }
}
