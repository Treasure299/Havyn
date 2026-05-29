using CefSharp;
using CefSharp.Handler;

namespace Havyn.Windows;

internal sealed class HavynAdBlockRequestHandler : RequestHandler
{
    private readonly Func<bool> isEnabled;
    private readonly HavynAdBlockResourceRequestHandler resourceHandler;

    public HavynAdBlockRequestHandler(Func<bool> isEnabled)
    {
        this.isEnabled = isEnabled;
        resourceHandler = new HavynAdBlockResourceRequestHandler(isEnabled);
    }

    protected override IResourceRequestHandler? GetResourceRequestHandler(
        IWebBrowser chromiumWebBrowser,
        IBrowser browser,
        IFrame frame,
        IRequest request,
        bool isNavigation,
        bool isDownload,
        string requestInitiator,
        ref bool disableDefaultHandling)
    {
        if (isDownload || isNavigation || !isEnabled())
        {
            return null;
        }

        return resourceHandler;
    }
}

internal sealed class HavynAdBlockResourceRequestHandler : ResourceRequestHandler
{
    private readonly Func<bool> isEnabled;

    private static readonly string[] SafeStreamingHosts =
    [
        "youtube.com",
        "youtu.be",
        "netflix.com",
        "primevideo.com",
        "amazonvideo.com",
        "hulu.com",
        "disneyplus.com",
        "max.com",
        "hbomax.com",
        "peacocktv.com",
        "twitch.tv"
    ];

    private static readonly string[] BlockedHostParts =
    [
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google.",
        "adnxs.com",
        "adsystem.com",
        "adform.net",
        "taboola.com",
        "outbrain.com",
        "popads.net",
        "propellerads.com",
        "mgid.com",
        "scorecardresearch.com",
        "zedo.com",
        "exoclick.com",
        "trafficjunky.net",
        "adskeeper.com",
        "adsterra.com",
        "analytics.google.com",
        "googletagmanager.com",
        "facebook.net",
        "hotjar.com"
    ];

    private static readonly string[] BlockedPathParts =
    [
        "/ads?",
        "/ads/",
        "/adserver",
        "/prebid",
        "/popunder",
        "/popup",
        "/banner",
        "/vast",
        "/vpaid",
        "/doubleclick",
        "googleads",
        "ad_tag",
        "adunit",
        "adclick"
    ];

    public HavynAdBlockResourceRequestHandler(Func<bool> isEnabled)
    {
        this.isEnabled = isEnabled;
    }

    protected override CefReturnValue OnBeforeResourceLoad(
        IWebBrowser chromiumWebBrowser,
        IBrowser browser,
        IFrame frame,
        IRequest request,
        IRequestCallback callback)
    {
        return ShouldBlock(request.Url) ? CefReturnValue.Cancel : CefReturnValue.Continue;
    }

    private bool ShouldBlock(string? url)
    {
        if (!isEnabled() || string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            return false;
        }

        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
        {
            return false;
        }

        var host = uri.Host.ToLowerInvariant();
        if (SafeStreamingHosts.Any(suffix => host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal)))
        {
            return false;
        }

        var haystack = (host + uri.PathAndQuery).ToLowerInvariant();
        return BlockedHostParts.Any(haystack.Contains) || BlockedPathParts.Any(haystack.Contains);
    }
}
