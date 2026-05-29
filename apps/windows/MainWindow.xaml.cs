using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using CefSharp;

namespace Havyn.Windows;

public partial class MainWindow : Window
{
    private bool isFullscreen;
    private WindowState previousState;
    private WindowStyle previousStyle;
    private ResizeMode previousResizeMode;
    private Border? activeBubble;
    private Border? activeResizeBubble;
    private Point dragStart;
    private double dragOriginLeft;
    private double dragOriginTop;
    private double resizeOriginWidth;
    private double resizeOriginHeight;
    private bool chatPinned;
    private bool mediaFullscreenStylesActive;
    private bool adBlockerEnabled = true;
    private bool participantsOpen;
    private bool mediaDetected;
    private readonly DispatcherTimer chatIdleTimer;

    public MainWindow()
    {
        InitializeComponent();
        previousState = WindowState;
        previousStyle = WindowStyle;
        previousResizeMode = ResizeMode;
        Browser.JavascriptObjectRepository.Register("havynBridge", new BrowserBridge(this), new BindingOptions());
        chatIdleTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(4) };
        chatIdleTimer.Tick += (_, _) =>
        {
            chatIdleTimer.Stop();
            if (!chatPinned) Fade(FullscreenChat, 0);
        };
        SizeChanged += (_, _) => ClampFullscreenBubbles();
    }

    public void UpdateDetectedMedia(string title)
    {
        var label = string.IsNullOrWhiteSpace(title) ? "Detected video" : title;
        mediaDetected = true;
        MediaTitleText.Text = label;
        FullscreenMediaTitleText.Text = label;
        UpdateMediaSourceStatus("Ready to sync", label, "Detected");
    }

    public void UpdatePlaybackSnapshot(string eventName, double currentTime, double duration, bool paused)
    {
        if (duration > 0)
        {
            foreach (var slider in FindVisualChildren<Slider>(Root).Where(slider => slider.Name == "ProgressSlider"))
            {
                slider.Maximum = duration;
                slider.Value = Math.Clamp(currentTime, 0, duration);
            }
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

        mediaDetected = false;
        UpdateMediaSourceStatus("Looking for media", "Open a video page. Havyn will detect a playable source here.", "Searching");
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

    private void Reload_Click(object sender, RoutedEventArgs e) => Browser.Reload();

    private void ToggleAdBlock_Click(object sender, RoutedEventArgs e)
    {
        adBlockerEnabled = !adBlockerEnabled;
        AdBlockButton.Opacity = adBlockerEnabled ? 1 : 0.48;
        AdBlockButton.ToolTip = adBlockerEnabled ? "Ad blocker on" : "Ad blocker off";
    }

    private void ToggleParticipants_Click(object sender, RoutedEventArgs e)
    {
        participantsOpen = !participantsOpen;
        foreach (var list in FindVisualChildren<ScrollViewer>(Root).Where(item => item.Name == "ParticipantsList"))
        {
            list.Visibility = participantsOpen ? Visibility.Visible : Visibility.Collapsed;
        }

        foreach (var chevron in FindVisualChildren<TextBlock>(Root).Where(item => item.Name == "ParticipantsChevron"))
        {
            chevron.Text = participantsOpen ? "^" : "v";
        }
    }

    private void SyncSource_Click(object sender, RoutedEventArgs e)
    {
        if (!mediaDetected) return;
        UpdateMediaSourceStatus("Source synced", "Participants will load this media source.", "Active");
    }

    private void UpdateMediaSourceStatus(string state, string hint, string pill)
    {
        foreach (var text in FindVisualChildren<TextBlock>(Root))
        {
            switch (text.Name)
            {
                case "MediaSourceStateText":
                    text.Text = state;
                    break;
                case "MediaSourceHintText":
                    text.Text = hint;
                    break;
                case "MediaStatusPill":
                    text.Text = pill;
                    break;
            }
        }

        foreach (var button in FindVisualChildren<Button>(Root).Where(item => item.Name == "SyncSourceButton"))
        {
            button.IsEnabled = mediaDetected;
            button.Opacity = mediaDetected ? 1 : 0.5;
        }
    }

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Fullscreen_Click(object sender, RoutedEventArgs e) => ToggleFullscreen();
    private void FirstSyncPlay_Click(object sender, RoutedEventArgs e) => PlayPause_Click(sender, e);

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
            ShowFullscreenLayout();
            return;
        }

        WindowStyle = previousStyle;
        ResizeMode = previousResizeMode;
        WindowState = previousState;
        isFullscreen = false;
        ShowStandardLayout();
    }

    private void ShowFullscreenLayout()
    {
        MoveBrowserTo(FullscreenBrowserHost);
        ApplyMediaFullscreenStyles(true);
        StandardOverlay.Visibility = Visibility.Collapsed;
        FullscreenOverlay.Visibility = Visibility.Visible;
        PositionFullscreenBubbles();
        Fade(FullscreenOverlay, 1, 180);
        Fade(FullscreenChat, 0, 120);
    }

    private void ShowStandardLayout()
    {
        ApplyMediaFullscreenStyles(false);
        MoveBrowserTo(StandardBrowserHost);
        StandardOverlay.Visibility = Visibility.Visible;
        Fade(FullscreenOverlay, 0, 120, () => FullscreenOverlay.Visibility = Visibility.Collapsed);
    }

    private void MoveBrowserTo(Grid host)
    {
        if (Browser.Parent is Panel currentParent)
        {
            currentParent.Children.Remove(Browser);
        }

        if (!host.Children.Contains(Browser))
        {
            host.Children.Insert(0, Browser);
        }
    }

    private void PositionFullscreenBubbles()
    {
        var right = Math.Max(20, ActualWidth - 336);
        Canvas.SetLeft(BubbleYou, right);
        Canvas.SetTop(BubbleYou, 76);
        Canvas.SetLeft(BubbleAuen, right);
        Canvas.SetTop(BubbleAuen, 250);
        ClampFullscreenBubbles();
    }

    private void ClampFullscreenBubbles()
    {
        if (!isFullscreen || BubbleCanvas.ActualWidth <= 0 || BubbleCanvas.ActualHeight <= 0) return;
        ClampBubble(BubbleYou);
        ClampBubble(BubbleAuen);
    }

    private void ClampBubble(Border bubble)
    {
        var left = Canvas.GetLeft(bubble);
        var top = Canvas.GetTop(bubble);
        if (double.IsNaN(left)) left = 0;
        if (double.IsNaN(top)) top = 0;
        Canvas.SetLeft(bubble, Math.Clamp(left, 12, Math.Max(12, BubbleCanvas.ActualWidth - bubble.Width - 12)));
        Canvas.SetTop(bubble, Math.Clamp(top, 68, Math.Max(68, BubbleCanvas.ActualHeight - bubble.Height - 12)));
    }

    private void Bubble_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (sender is not Border bubble) return;
        if (ReferenceEquals(e.OriginalSource, ResizeYou) || ReferenceEquals(e.OriginalSource, ResizeAuen)) return;
        activeBubble = bubble;
        dragStart = e.GetPosition(BubbleCanvas);
        dragOriginLeft = Canvas.GetLeft(bubble);
        dragOriginTop = Canvas.GetTop(bubble);
        if (double.IsNaN(dragOriginLeft)) dragOriginLeft = 0;
        if (double.IsNaN(dragOriginTop)) dragOriginTop = 0;
        bubble.CaptureMouse();
        e.Handled = true;
    }

    private void Bubble_MouseMove(object sender, MouseEventArgs e)
    {
        if (activeBubble is null || e.LeftButton != MouseButtonState.Pressed) return;
        var current = e.GetPosition(BubbleCanvas);
        Canvas.SetLeft(activeBubble, dragOriginLeft + current.X - dragStart.X);
        Canvas.SetTop(activeBubble, dragOriginTop + current.Y - dragStart.Y);
        ClampBubble(activeBubble);
    }

    private void Bubble_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        activeBubble?.ReleaseMouseCapture();
        activeBubble = null;
    }

    private void Resize_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        activeResizeBubble = FindParent<Border>((DependencyObject)sender);
        if (activeResizeBubble is null) return;
        dragStart = e.GetPosition(BubbleCanvas);
        resizeOriginWidth = activeResizeBubble.Width;
        resizeOriginHeight = activeResizeBubble.Height;
        ((UIElement)sender).CaptureMouse();
        e.Handled = true;
    }

    private void Resize_MouseMove(object sender, MouseEventArgs e)
    {
        if (activeResizeBubble is null || e.LeftButton != MouseButtonState.Pressed) return;
        var current = e.GetPosition(BubbleCanvas);
        var nextWidth = Math.Clamp(resizeOriginWidth + current.X - dragStart.X, 210, 420);
        activeResizeBubble.Width = nextWidth;
        activeResizeBubble.Height = nextWidth * 9 / 16;
        ClampBubble(activeResizeBubble);
        e.Handled = true;
    }

    private void Resize_MouseLeftButtonUp(object sender, MouseButtonEventArgs e)
    {
        ((UIElement)sender).ReleaseMouseCapture();
        activeResizeBubble = null;
    }

    private void ChatOverlay_MouseEnter(object sender, MouseEventArgs e)
    {
        chatPinned = true;
        chatIdleTimer.Stop();
        Fade(FullscreenChat, 1);
    }

    private void ChatOverlay_MouseLeave(object sender, MouseEventArgs e)
    {
        chatPinned = false;
        chatIdleTimer.Stop();
        chatIdleTimer.Start();
    }

    private void ShowChatForNewMessage()
    {
        if (!isFullscreen) return;
        Fade(FullscreenChat, 1);
        chatIdleTimer.Stop();
        chatIdleTimer.Start();
    }

    private static void Fade(UIElement element, double to, int ms = 180, Action? completed = null)
    {
        var animation = new DoubleAnimation(to, TimeSpan.FromMilliseconds(ms))
        {
            EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut }
        };
        if (completed is not null)
        {
            animation.Completed += (_, _) => completed();
        }
        element.BeginAnimation(OpacityProperty, animation);
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
        ExecuteScriptOnAllFrames(script);
    }

    private void ApplyMediaFullscreenStyles(bool enabled)
    {
        if (!Browser.IsBrowserInitialized) return;
        mediaFullscreenStylesActive = enabled;

        var script = enabled
            ? """
              (() => {
                if (!window.__havynFullscreenRestore) {
                  window.__havynFullscreenRestore = {
                    bodyOverflow: document.body.style.overflow || '',
                    htmlOverflow: document.documentElement.style.overflow || '',
                    markedFrames: []
                  };
                }
                const markMediaFrames = () => {
                  document.querySelectorAll('iframe').forEach((frame) => {
                    try {
                      if (frame.contentDocument?.querySelector('video')) {
                        frame.classList.add('__havynFullscreenFrame');
                        window.__havynFullscreenRestore.markedFrames.push(frame);
                      }
                    } catch {}
                  });
                };
                let style = document.getElementById('__havynFullscreenMediaStyle');
                if (!style) {
                  style = document.createElement('style');
                  style.id = '__havynFullscreenMediaStyle';
                  document.head.appendChild(style);
                }
                style.textContent = `
                  html, body {
                    width: 100vw !important;
                    height: 100vh !important;
                    margin: 0 !important;
                    overflow: hidden !important;
                    background: #000 !important;
                  }
                  .__havynFullscreenFrame {
                    position: fixed !important;
                    inset: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    max-width: none !important;
                    max-height: none !important;
                    border: 0 !important;
                    z-index: 2147482999 !important;
                    background: #000 !important;
                  }
                  video {
                    position: fixed !important;
                    inset: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    max-width: none !important;
                    max-height: none !important;
                    object-fit: contain !important;
                    background: #000 !important;
                    z-index: 2147483000 !important;
                  }
                `;
                markMediaFrames();
                document.documentElement.style.overflow = 'hidden';
                document.body.style.overflow = 'hidden';
                return 'fullscreen-video';
              })();
              """
            : """
              (() => {
                const style = document.getElementById('__havynFullscreenMediaStyle');
                if (style) style.remove();
                const restore = window.__havynFullscreenRestore;
                if (restore) {
                  document.querySelectorAll('.__havynFullscreenFrame').forEach((frame) => {
                    frame.classList.remove('__havynFullscreenFrame');
                  });
                  document.body.style.overflow = restore.bodyOverflow || '';
                  document.documentElement.style.overflow = restore.htmlOverflow || '';
                }
                window.__havynFullscreenRestore = null;
                return 'restored-video';
              })();
              """;

        ExecuteScriptOnAllFrames(script);
    }

    private void ExecuteScriptOnAllFrames(string script)
    {
        if (!Browser.IsBrowserInitialized) return;

        try
        {
            var browser = Browser.GetBrowser();
            foreach (var frameId in browser.GetFrameIdentifiers())
            {
                browser.GetFrameByIdentifier(frameId)?.EvaluateScriptAsync(script);
            }
        }
        catch
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

        if (mediaFullscreenStylesActive)
        {
            Dispatcher.InvokeAsync(() => ApplyMediaFullscreenStyles(true));
        }

        if (!e.Frame.IsMain) return;

        Dispatcher.InvokeAsync(() =>
        {
            MediaTitleText.Text = string.IsNullOrWhiteSpace(Browser.Title)
                ? "Detected video"
                : Browser.Title;
        });
    }

    private static T? FindParent<T>(DependencyObject child) where T : DependencyObject
    {
        var parent = VisualTreeHelper.GetParent(child);
        while (parent is not null)
        {
            if (parent is T match) return match;
            parent = VisualTreeHelper.GetParent(parent);
        }
        return null;
    }

    private static IEnumerable<T> FindVisualChildren<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T match) yield return match;
            foreach (var descendant in FindVisualChildren<T>(child))
            {
                yield return descendant;
            }
        }
    }
}
