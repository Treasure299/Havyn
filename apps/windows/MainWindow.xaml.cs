using System.Windows;
using System.Windows.Input;
using CefSharp;

namespace Havyn.Windows;

public partial class MainWindow : Window
{
    private bool isFullscreen;
    private WindowState previousState;
    private WindowStyle previousStyle;
    private ResizeMode previousResizeMode;

    public MainWindow()
    {
        InitializeComponent();
        previousState = WindowState;
        previousStyle = WindowStyle;
        previousResizeMode = ResizeMode;
        Browser.JavascriptObjectRepository.Register("havynBridge", new BrowserBridge(this), new BindingOptions());
    }

    public void UpdateDetectedMedia(string title)
    {
        MediaTitleText.Text = string.IsNullOrWhiteSpace(title) ? "Detected video" : title;
    }

    public void UpdatePlaybackSnapshot(string eventName, double currentTime, double duration, bool paused)
    {
        CenterPlayButton.Content = paused ? "Play" : "Pause";
        if (duration > 0)
        {
            ProgressSlider.Maximum = duration;
            ProgressSlider.Value = Math.Clamp(currentTime, 0, duration);
        }
    }

    private void Chrome_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            ToggleFullscreen();
            return;
        }

        DragMove();
    }

    private void AddressBox_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            LoadAddress();
        }
    }

    private void Load_Click(object sender, RoutedEventArgs e) => LoadAddress();

    private void LoadAddress()
    {
        var target = AddressBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(target)) return;
        if (!target.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !target.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            target = $"https://{target}";
        }

        Browser.Load(target);
    }

    private void Back_Click(object sender, RoutedEventArgs e)
    {
        if (Browser.CanGoBack) Browser.Back();
    }

    private void Forward_Click(object sender, RoutedEventArgs e)
    {
        if (Browser.CanGoForward) Browser.Forward();
    }

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Fullscreen_Click(object sender, RoutedEventArgs e) => ToggleFullscreen();

    private void ToggleFullscreen()
    {
        if (!isFullscreen)
        {
            previousState = WindowState;
            previousStyle = WindowStyle;
            previousResizeMode = ResizeMode;
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
            isFullscreen = true;
            return;
        }

        WindowStyle = previousStyle;
        ResizeMode = previousResizeMode;
        WindowState = previousState;
        isFullscreen = false;
    }

    private void PlayPause_Click(object sender, RoutedEventArgs e)
    {
        ExecuteMediaScript("""
            (() => {
              const video = document.querySelector('video');
              if (!video) return 'no-video';
              if (video.paused) { video.play(); return 'play'; }
              video.pause();
              return 'pause';
            })();
            """);
    }

    private void BackTen_Click(object sender, RoutedEventArgs e)
    {
        ExecuteMediaScript("""
            (() => {
              const video = document.querySelector('video');
              if (!video) return 'no-video';
              video.currentTime = Math.max(0, video.currentTime - 10);
              return video.currentTime;
            })();
            """);
    }

    private void ForwardTen_Click(object sender, RoutedEventArgs e)
    {
        ExecuteMediaScript("""
            (() => {
              const video = document.querySelector('video');
              if (!video) return 'no-video';
              video.currentTime = Math.min(video.duration || Number.MAX_SAFE_INTEGER, video.currentTime + 10);
              return video.currentTime;
            })();
            """);
    }

    private void ExecuteMediaScript(string script)
    {
        if (Browser.IsBrowserInitialized)
        {
            Browser.GetMainFrame().EvaluateScriptAsync(script);
        }
    }

    private void Browser_LoadingStateChanged(object? sender, LoadingStateChangedEventArgs e)
    {
        if (!e.IsLoading)
        {
            Dispatcher.Invoke(() =>
            {
                AddressBox.Text = Browser.Address;
            });
        }
    }

    private void Browser_FrameLoadEnd(object? sender, FrameLoadEndEventArgs e)
    {
        if (!e.Frame.IsMain) return;

        e.Frame.ExecuteJavaScriptAsync("""
            (() => {
              if (window.__havynDetectorInstalled) return;
              window.__havynDetectorInstalled = true;
              const notify = async (name, video) => {
                try {
                  await CefSharp.BindObjectAsync('havynBridge');
                  const title = document.title || video.getAttribute('title') || 'Detected video';
                  window.havynBridge.mediaDetected(title);
                  window.havynBridge.mediaEvent(
                    name,
                    video.currentTime || 0,
                    Number.isFinite(video.duration) ? video.duration : 0,
                    video.paused
                  );
                } catch {}
              };
              const describe = () => {
                const video = document.querySelector('video');
                if (!video) return null;
                return {
                  title: document.title || 'Detected video',
                  currentTime: video.currentTime || 0,
                  duration: Number.isFinite(video.duration) ? video.duration : 0,
                  paused: video.paused,
                  playbackRate: video.playbackRate || 1
                };
              };
              window.__havynDescribeMedia = describe;
              const attach = (video) => {
                if (!video || video.dataset.havynAttached) return;
                video.dataset.havynAttached = 'true';
                ['play','pause','seeked','timeupdate','ratechange','loadedmetadata','canplay'].forEach((name) => {
                  video.addEventListener(name, () => notify(name, video), true);
                });
                notify('detected', video);
              };
              document.querySelectorAll('video').forEach(attach);
              new MutationObserver(() => document.querySelectorAll('video').forEach(attach))
                .observe(document.documentElement, { childList: true, subtree: true });
            })();
            """);

        Dispatcher.InvokeAsync(() =>
        {
            MediaTitleText.Text = string.IsNullOrWhiteSpace(Browser.Title)
                ? "Detected video"
                : Browser.Title;
        });
    }
}
