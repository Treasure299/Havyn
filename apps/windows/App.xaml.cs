using System.IO;
using System.Windows;
using CefSharp;
using CefSharp.Wpf;

namespace Havyn.Windows;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        var cachePath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Havyn",
            "CefCache");

        var settings = new CefSettings
        {
            CachePath = cachePath,
            PersistSessionCookies = true,
            UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
        };
        settings.CefCommandLineArgs["autoplay-policy"] = "no-user-gesture-required";
        settings.CefCommandLineArgs["disable-blink-features"] = "AutomationControlled";

        Cef.Initialize(settings, performDependencyCheck: true, browserProcessHandler: null);
        base.OnStartup(e);
    }

    protected override void OnExit(ExitEventArgs e)
    {
        Cef.Shutdown();
        base.OnExit(e);
    }
}
