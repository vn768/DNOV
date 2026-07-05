using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using System.Net.Http.Json;
using System.Text.Json;

namespace DNOV.Pages
{
    public partial class BogorovRhytm : ComponentBase, IAsyncDisposable
    {
        [Inject] private IJSRuntime JS { get; set; } = default!;
        [Inject] private HttpClient Http { get; set; } = default!;

        private IJSObjectReference? _module;
        private IJSObjectReference? _gameInstance;
        private DotNetObjectReference<BogorovRhytm>? _dotNetRef;

        private ElementReference _canvas;
        private ElementReference _audioRef;

        private RhythmMap? CurrentMap;

        public string CurrentMapPath = "";

        // ---- Stats / game-over state ----
        public bool ShowStats { get; private set; }
        public int FinalScore { get; private set; }
        public int FinalCombo { get; private set; }

        // ---- Map selection state ----

        public class MapEntry
        {
            public string Title { get; set; } = "";
            public string JsonPath { get; set; } = "";
            public string Thumbnail { get; set; } = ""; // optional, for a nicer button
        }

        private List<MapEntry> AvailableMaps = new()
        {
            new MapEntry { Title = "Map1", JsonPath = "Rhytm%20maps/Angela_map.json" },
            new MapEntry { Title = "Map 2", JsonPath = "Rhytm%20maps/Map1.json" },
        };

        private bool GameStarted = false;
        private string? LoadError = null;

        // ---- Lifecycle ----

        protected override async Task OnAfterRenderAsync(bool firstRender)
        {
            // Intentionally empty — the game no longer auto-loads on first
            // render. Loading/initializing now happens when the player picks
            // a map from the selection screen (see SelectMap below).
            await Task.CompletedTask;
        }

        // ---- Map selection flow ----

        private async Task SelectMap(MapEntry entry)
        {
            LoadError = null;
            ShowStats = false;
            CurrentMapPath = entry.JsonPath;
            GameStarted = true;

            // Force a render first so the <canvas> element actually exists
            // in the DOM before JS interop tries to grab it by id.
            StateHasChanged();
            await Task.Yield();

            try
            {
                await LoadMap(CurrentMapPath);
                // Render again so the <audio> element (only rendered once
                // CurrentMap has an AudioFile) exists before we grab its ref.
                StateHasChanged();
                await Task.Yield();
                await InitializeGame();
            }
            catch (Exception ex)
            {
                // Surface the failure in the UI instead of letting it bubble
                // up as an unhandled exception that tears down the whole
                // Blazor render tree.
                LoadError = $"[BUILD-CHECK-{DateTime.Now:HHmmss}] Couldn't load this song: {ex.Message}";
                GameStarted = false;
                StateHasChanged();
            }
        }

        private async Task BackToMenu()
        {
            if (_gameInstance != null)
            {
                await _gameInstance.InvokeVoidAsync("dispose");
                await _gameInstance.DisposeAsync();
                _gameInstance = null;
            }

            _dotNetRef?.Dispose();
            _dotNetRef = null;

            ShowStats = false;
            GameStarted = false;
            CurrentMap = null;
            StateHasChanged();
        }

        // Called from JS the moment a map finishes playing. Audio is already
        // paused by the JS side before this fires.
        [JSInvokable]
        public void OnGameFinished(int score, int maxCombo)
        {
            FinalScore = score;
            FinalCombo = maxCombo;
            ShowStats = true;
            StateHasChanged();
        }

        // ---- Map loading ----

        private async Task LoadMap(string mapPath)
        {
            CurrentMap = await Http.GetFromJsonAsync<RhythmMap>(mapPath);

            if (CurrentMap == null)
            {
                CurrentMap = new RhythmMap();
            }
        }

        private async Task InitializeGame()
        {
            if (CurrentMap == null)
                return;

            _module = await JS.InvokeAsync<IJSObjectReference>(
                "import",
                "/Pages/BogorocRhytm.razor.js"
            );

            _dotNetRef = DotNetObjectReference.Create(this);

            _gameInstance = await _module.InvokeAsync<IJSObjectReference>(
                "createBogorocRhytm",
                "rhythmCanvas",
                CurrentMap,
                _audioRef,
                _dotNetRef
            );
        }

        public async Task ReloadMap(string newMapPath)
        {
            CurrentMapPath = newMapPath;
            ShowStats = false;

            await LoadMap(CurrentMapPath);

            if (_gameInstance != null)
            {
                await _gameInstance.InvokeVoidAsync("dispose");
                await _gameInstance.DisposeAsync();
                _gameInstance = null;
            }

            await InitializeGame();
        }

        public async Task LoadCustomMap(RhythmMap map)
        {
            CurrentMap = map;
            GameStarted = true;
            ShowStats = false;
            StateHasChanged();
            await Task.Yield();

            if (_gameInstance != null)
            {
                await _gameInstance.InvokeVoidAsync("dispose");
                await _gameInstance.DisposeAsync();
                _gameInstance = null;
            }

            await InitializeGame();
        }

        public async Task SaveCustomMap()
        {
            if (CurrentMap == null)
                return;

            var json = JsonSerializer.Serialize(
                CurrentMap,
                new JsonSerializerOptions
                {
                    WriteIndented = true
                });

            var fileName = $"custom_{DateTime.Now.Ticks}.json";

            await File.WriteAllTextAsync(
                Path.Combine("wwwroot/maps", fileName),
                json
            );
        }

        public async ValueTask DisposeAsync()
        {
            if (_gameInstance != null)
            {
                await _gameInstance.InvokeVoidAsync("dispose");
                await _gameInstance.DisposeAsync();
            }

            if (_module != null)
            {
                await _module.DisposeAsync();
            }

            _dotNetRef?.Dispose();
        }
    }

    public class RhythmMap
    {
        public string Song { get; set; } = "";
        public string AudioFile { get; set; } = "";
        public double BPM { get; set; }
        public int DurationMs { get; set; }
        public int? TravelTimeMs { get; set; }
        public List<NoteEvent> Notes { get; set; } = new();
        public List<BubbleEvent> Bubbles { get; set; } = new();
        public List<SegmentEvent> Segments { get; set; } = new();
    }

    public class NoteEvent
    {
        public int Time { get; set; }
        public int Lane { get; set; }
        public string Type { get; set; } = "tap"; // "tap" or "hold"
        public int HoldMs { get; set; } = 0;       // only used when Type == "hold"
        public bool Hit { get; set; }
        public bool Missed { get; set; }
    }

    public class BubbleEvent
    {
        public string Type { get; set; } = "";
        public int Time { get; set; }
        public int Duration { get; set; }

        public float X { get; set; }
        public float Y { get; set; }

        public List<PathPoint> Path { get; set; } = new();

        public bool Done { get; set; }
    }

    public class PathPoint
    {
        public float X { get; set; }
        public float Y { get; set; }
    }

    // A "freestyle" window: keyboard notes fade out, the grid edges flash
    // red with warning marks leading in, and bubble events take over.
    public class SegmentEvent
    {
        public int Start { get; set; }
        public int End { get; set; }
    }
}