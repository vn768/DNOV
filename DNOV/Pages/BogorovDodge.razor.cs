using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace DNOV.Pages;

public partial class BogorovDodge : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;

    private ElementReference _canvasRef;
    private IJSObjectReference? _module;
    private DotNetObjectReference<BogorovDodge>? _selfRef;
    private DodgeProgress _progress = new();
    private sealed record AchievementDef(string Id, string Title, string Description, int ThresholdSeconds);
    private readonly List<AchievementDef> _achievements = new()
    {
        new("quick_reflexes", "15 seconds",     "Survive 15 seconds",  15),
        new("warmed_up",      "30 seconds",  "Survive 30 seconds",  30),
        new("one_minute",     "1 minutes",  "Survive 1 minute",    60),
        new("dodge_master",   "2 minutes",       "Survive 2 minutes",   120),
        new("untouchable",    "3 minutes",        "Survive 3 minutes",   180),
        new("survivor",       "5 minutes",           "Survive 5 minutes",   300),
        new("legend",         "10 minutes",             "Survive 10 minutes",  600),
    };

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender) return;

        _module = await JS.InvokeAsync<IJSObjectReference>("import", "./Pages/BogorovDodge.razor.js");
        _selfRef = DotNetObjectReference.Create(this);

        var thresholds = _achievements
            .Select(a => new { id = a.Id, thresholdSeconds = a.ThresholdSeconds })
            .ToArray();

        _progress = await _module.InvokeAsync<DodgeProgress>("init", _canvasRef, _selfRef, thresholds);
        StateHasChanged();
    }
    [JSInvokable]
    public Task OnAchievementUnlocked(string id)
    {
        if (_progress.Unlocked.Add(id))
        {
            StateHasChanged();
        }
        return Task.CompletedTask;
    }
    [JSInvokable]
    public Task OnGameOver(double survivedSeconds)
    {
        var ms = survivedSeconds * 1000;
        if (ms > _progress.BestTimeMs)
        {
            _progress.BestTimeMs = ms;
        }
        StateHasChanged();
        return Task.CompletedTask;
    }
    private static string FormatTime(double ms)
    {
        var totalSeconds = ms / 1000.0;
        var minutes = (int)(totalSeconds / 60);
        var seconds = totalSeconds - (minutes * 60);
        return $"{minutes:00}:{seconds:00.0}";
    }
    public async ValueTask DisposeAsync()
    {
        _selfRef?.Dispose();

        if (_module is not null)
        {
            try
            {
                await _module.InvokeVoidAsync("dispose");
            }
            catch (JSDisconnectedException)
            {

            }

            await _module.DisposeAsync();
        }
    }
    private sealed class DodgeProgress
    {
        public double BestTimeMs { get; set; }
        public HashSet<string> Unlocked { get; set; } = new();
    }
}