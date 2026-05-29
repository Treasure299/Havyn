using CefSharp;
using CefSharp.Handler;

namespace Havyn.Windows;

internal sealed class HavynAdBlockRequestHandler : RequestHandler
{
    private readonly Func<bool> isEnabled;
    private readonly HavynAdBlockResourceRequestHandler resourceHandler;
    private readonly FilterListAdBlockEngine engine;

    public HavynAdBlockRequestHandler(Func<bool> isEnabled)
    {
        this.isEnabled = isEnabled;
        engine = new FilterListAdBlockEngine();
        resourceHandler = new HavynAdBlockResourceRequestHandler(isEnabled, engine);
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
    private readonly FilterListAdBlockEngine engine;

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

    public HavynAdBlockResourceRequestHandler(Func<bool> isEnabled, FilterListAdBlockEngine engine)
    {
        this.isEnabled = isEnabled;
        this.engine = engine;
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

        if (LooksLikeMediaRequest(uri))
        {
            return false;
        }

        return engine.ShouldBlock(uri);
    }

    private static bool LooksLikeMediaRequest(Uri uri)
    {
        var path = uri.AbsolutePath.ToLowerInvariant();
        return path.EndsWith(".m3u8", StringComparison.Ordinal) ||
               path.EndsWith(".mpd", StringComparison.Ordinal) ||
               path.EndsWith(".mp4", StringComparison.Ordinal) ||
               path.EndsWith(".m4v", StringComparison.Ordinal) ||
               path.EndsWith(".webm", StringComparison.Ordinal) ||
               path.EndsWith(".m4s", StringComparison.Ordinal) ||
               path.EndsWith(".ts", StringComparison.Ordinal) ||
               path.EndsWith(".mov", StringComparison.Ordinal) ||
               path.EndsWith(".aac", StringComparison.Ordinal) ||
               path.EndsWith(".mp3", StringComparison.Ordinal) ||
               path.EndsWith(".ogg", StringComparison.Ordinal) ||
               path.Contains("/hls/", StringComparison.Ordinal) ||
               path.Contains("/dash/", StringComparison.Ordinal) ||
               path.Contains("/manifest", StringComparison.Ordinal);
    }
}
