using System.IO;
using System.Net.Http;

namespace Havyn.Windows;

internal sealed class FilterListAdBlockEngine
{
    private static readonly Uri[] RemoteLists =
    [
        new("https://easylist.to/easylist/easylist.txt"),
        new("https://easylist.to/easylist/easyprivacy.txt")
    ];

    private static readonly string[] BuiltInBlockedHosts =
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

    private static readonly string[] BuiltInPathParts =
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

    private readonly string listDirectory;
    private volatile FilterSet filters = FilterSet.CreateBuiltIn(BuiltInBlockedHosts, BuiltInPathParts);

    public FilterListAdBlockEngine()
    {
        listDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Havyn",
            "AdBlock");

        Directory.CreateDirectory(listDirectory);
        LoadCachedLists();
        _ = RefreshListsAsync();
    }

    public bool ShouldBlock(Uri uri)
    {
        return filters.ShouldBlock(uri);
    }

    private void LoadCachedLists()
    {
        var files = Directory.GetFiles(listDirectory, "*.txt");
        if (files.Length == 0)
        {
            return;
        }

        var lines = files.SelectMany(ReadLinesSafely);
        filters = FilterSet.FromLines(lines, BuiltInBlockedHosts, BuiltInPathParts);
    }

    private async Task RefreshListsAsync()
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(18) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("Havyn/0.1 adblock-filter-refresh");

            foreach (var list in RemoteLists)
            {
                var text = await client.GetStringAsync(list).ConfigureAwait(false);
                var fileName = list.Segments.LastOrDefault()?.Replace("/", "", StringComparison.Ordinal) ?? "filters.txt";
                await File.WriteAllTextAsync(Path.Combine(listDirectory, fileName), text).ConfigureAwait(false);
            }

            LoadCachedLists();
        }
        catch
        {
            // Keep the built-in/cached rules. Browsing should never fail because filter refresh failed.
        }
    }

    private static IEnumerable<string> ReadLinesSafely(string file)
    {
        try
        {
            return File.ReadLines(file);
        }
        catch
        {
            return [];
        }
    }
}

internal sealed class FilterSet
{
    private readonly string[] blockedHostSuffixes;
    private readonly string[] blockedFragments;
    private readonly string[] exceptionHostSuffixes;
    private readonly string[] exceptionFragments;

    private FilterSet(
        string[] blockedHostSuffixes,
        string[] blockedFragments,
        string[] exceptionHostSuffixes,
        string[] exceptionFragments)
    {
        this.blockedHostSuffixes = blockedHostSuffixes;
        this.blockedFragments = blockedFragments;
        this.exceptionHostSuffixes = exceptionHostSuffixes;
        this.exceptionFragments = exceptionFragments;
    }

    public static FilterSet CreateBuiltIn(IEnumerable<string> hostRules, IEnumerable<string> fragmentRules)
    {
        return new FilterSet(
            hostRules.Select(NormalizeHostRule).Distinct().ToArray(),
            fragmentRules.Select(rule => rule.ToLowerInvariant()).Distinct().ToArray(),
            [],
            []);
    }

    public static FilterSet FromLines(
        IEnumerable<string> lines,
        IEnumerable<string> builtInHostRules,
        IEnumerable<string> builtInFragmentRules)
    {
        var hosts = builtInHostRules.Select(NormalizeHostRule).ToList();
        var fragments = builtInFragmentRules.Select(rule => rule.ToLowerInvariant()).ToList();
        var exceptionHosts = new List<string>();
        var exceptionFragments = new List<string>();

        foreach (var rawLine in lines)
        {
            var parsed = ParseRule(rawLine);
            if (parsed is null)
            {
                continue;
            }

            var (rule, isException) = parsed.Value;
            if (TryGetHostRule(rule, out var hostRule))
            {
                if (isException)
                {
                    exceptionHosts.Add(hostRule);
                }
                else
                {
                    hosts.Add(hostRule);
                }

                continue;
            }

            var fragment = NormalizeFragmentRule(rule);
            if (fragment.Length < 4)
            {
                continue;
            }

            if (isException)
            {
                exceptionFragments.Add(fragment);
            }
            else
            {
                fragments.Add(fragment);
            }
        }

        return new FilterSet(
            hosts.Distinct().ToArray(),
            fragments.Distinct().ToArray(),
            exceptionHosts.Distinct().ToArray(),
            exceptionFragments.Distinct().ToArray());
    }

    public bool ShouldBlock(Uri uri)
    {
        var host = uri.Host.ToLowerInvariant();
        var full = (host + uri.PathAndQuery).ToLowerInvariant();

        if (MatchesHost(host, exceptionHostSuffixes) || exceptionFragments.Any(full.Contains))
        {
            return false;
        }

        return MatchesHost(host, blockedHostSuffixes) || blockedFragments.Any(full.Contains);
    }

    private static (string Rule, bool IsException)? ParseRule(string? rawLine)
    {
        if (string.IsNullOrWhiteSpace(rawLine))
        {
            return null;
        }

        var line = rawLine.Trim();
        if (line.StartsWith('!') ||
            line.StartsWith('[') ||
            line.Contains("##", StringComparison.Ordinal) ||
            line.Contains("#@#", StringComparison.Ordinal) ||
            line.Contains("#$#", StringComparison.Ordinal))
        {
            return null;
        }

        var isException = line.StartsWith("@@", StringComparison.Ordinal);
        if (isException)
        {
            line = line[2..];
        }

        var optionsIndex = line.IndexOf('$');
        if (optionsIndex >= 0)
        {
            line = line[..optionsIndex];
        }

        line = line.Trim();
        return line.Length == 0 ? null : (line, isException);
    }

    private static bool TryGetHostRule(string rule, out string host)
    {
        host = string.Empty;
        if (!rule.StartsWith("||", StringComparison.Ordinal))
        {
            return false;
        }

        var end = rule.IndexOfAny(['^', '/', ':', '*'], 2);
        var value = end >= 0 ? rule[2..end] : rule[2..];
        if (value.Length < 3 || value.Contains('*', StringComparison.Ordinal))
        {
            return false;
        }

        host = NormalizeHostRule(value);
        return host.Length > 0;
    }

    private static string NormalizeHostRule(string rule)
    {
        return rule.Trim().TrimStart('|').TrimEnd('^').ToLowerInvariant();
    }

    private static string NormalizeFragmentRule(string rule)
    {
        return rule
            .Replace("*", "", StringComparison.Ordinal)
            .Replace("^", "", StringComparison.Ordinal)
            .Replace("|", "", StringComparison.Ordinal)
            .ToLowerInvariant();
    }

    private static bool MatchesHost(string host, IEnumerable<string> suffixes)
    {
        return suffixes.Any(suffix => host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal));
    }
}
