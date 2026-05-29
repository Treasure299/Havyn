using System.Windows;

namespace Havyn.Windows;

public sealed class BrowserBridge
{
    private readonly MainWindow window;

    public BrowserBridge(MainWindow window)
    {
        this.window = window;
    }

    public void MediaDetected(string title)
    {
        window.Dispatcher.Invoke(() => window.UpdateDetectedMedia(title));
    }

    public void MediaEvent(string eventName, double currentTime, double duration, bool paused)
    {
        window.Dispatcher.Invoke(() => window.UpdatePlaybackSnapshot(eventName, currentTime, duration, paused));
    }
}
