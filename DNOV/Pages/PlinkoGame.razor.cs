using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace DNOV.Pages
{
    public partial class PlinkoGame : IAsyncDisposable
    {
        [Inject] IJSRuntime JS { get; set; } = default!;

        private IJSObjectReference? _jsModule;
        private DotNetObjectReference<PlinkoGame>? _dotnetRef;

        private double euro = 50;
        private double BallCost = 5;
        private double MoneyMultiplier = 1.0;
        private double BallSpeedMultiplier = 1.0;
        private System.Timers.Timer? _autoDropTimer;

        private List<PlinkoUpgrade> Upgrades = new();

        protected override void OnInitialized()
        {
            Upgrades = BuildUpgrades();
        }

        protected override async Task OnAfterRenderAsync(bool firstRender)
        {
            if (firstRender)
            {
                _dotnetRef = DotNetObjectReference.Create(this);
                _jsModule = await JS.InvokeAsync<IJSObjectReference>(
                    "import", "./Pages/PlinkoGame.razor.js");
                await _jsModule.InvokeVoidAsync("init", "plinkoCanvas", _dotnetRef);
            }
        }

        private async Task DropBall()
        {
            if (euro < BallCost || _jsModule is null) return;
            euro -= BallCost;

            int ballCount = 1 + (Upgrades.First(u => u.Id == 2).CurrentLevel);
            for (int i = 0; i < ballCount; i++)
            {
                await _jsModule.InvokeVoidAsync("dropBall", null);
            }
        }

        [JSInvokable]
        public async Task OnBallLanded(double multiplier)
        {
            euro += BallCost * multiplier * MoneyMultiplier;
            await InvokeAsync(StateHasChanged);
        }

        private async Task BuyUpgrade(PlinkoUpgrade upg)
        {
            if (!upg.CanAfford(euro) || upg.IsMaxed || _jsModule is null) return;
            euro -= upg.CurrentCost;
            upg.CurrentLevel++;
            ApplyUpgradeEffect(upg);
            await _jsModule.InvokeVoidAsync("updateSettings", new
            {
                gravity = 0.35,
                ballSpeedMultiplier = BallSpeedMultiplier,
                restitution = 0.5
            });
            StateHasChanged();
        }

        private void ApplyUpgradeEffect(PlinkoUpgrade upg)
        {
            switch (upg.Id)
            {
                case 1: MoneyMultiplier *= 1.08; break;
                case 2:  /* ball count handled in DropBall */ break;
                case 3: BallSpeedMultiplier *= 1.08; break;
                case 4: BallCost = Math.Max(1, BallCost * 0.95); break;
                case 5: SetupAutoDropper(upg.CurrentLevel); break;
                case 6: MoneyMultiplier *= 1.06; break;
                case 7: MoneyMultiplier *= 1.04; break;
                case 8: BallSpeedMultiplier *= 1.05; break;
                case 9: MoneyMultiplier *= 1.07; break;
                case 10: MoneyMultiplier *= 1.10; break;
                case 11: BallCost = Math.Max(1, BallCost * 0.97); break;
                case 12: MoneyMultiplier *= 1.06; break;
                case 13: MoneyMultiplier *= 1.07; break;
                case 14: MoneyMultiplier *= 1.09; break;
                case 15: MoneyMultiplier *= 1.12; break;
                case 16: BallSpeedMultiplier = Math.Max(0.3, BallSpeedMultiplier * 0.90); break;
                case 17: euro += BallCost * 0.10; break;
                case 18: MoneyMultiplier *= 1.07; break;
                case 19: MoneyMultiplier *= 1.05; break;
                case 20: MoneyMultiplier *= 1.15; break;
                case 21: MoneyMultiplier *= 1.09; break;
                case 22: BallSpeedMultiplier *= 1.06; break;
                case 23: MoneyMultiplier *= 1.10; break;
                case 24: euro += 20 * upg.CurrentLevel; break;
                case 25: MoneyMultiplier *= 1.50; BallCost = 5; break;
            }
        }

        private void SetupAutoDropper(int level)
        {
            _autoDropTimer?.Dispose();
            double interval = Math.Max(500, 5000 - (level * 400));
            _autoDropTimer = new System.Timers.Timer(interval);
            _autoDropTimer.Elapsed += async (_, _) =>
            {
                if (euro >= BallCost && _jsModule is not null)
                {
                    euro -= BallCost;
                    await _jsModule.InvokeVoidAsync("dropBall", null);
                    await InvokeAsync(StateHasChanged);
                }
            };
            _autoDropTimer.AutoReset = true;
            _autoDropTimer.Start();
        }

        public async ValueTask DisposeAsync()
        {
            _autoDropTimer?.Dispose();
            _dotnetRef?.Dispose();
            if (_jsModule is not null)
            {
                await _jsModule.InvokeVoidAsync("dispose");
                await _jsModule.DisposeAsync();
            }
        }

        private static List<PlinkoUpgrade> BuildUpgrades() => new()
        {
            new(1,  "Economics Major",    "💶", "Each level: +8% money per ball",            250,    UpgradeType.MoneyMultiplier),
            new(2,  "Trades Expert",      "💶", "Drop +1 extra ball per click per level",    2000,   UpgradeType.BallCount),
            new(3,  "Faster Production",  "💶", "Balls fall 8% faster per level",            7500,    UpgradeType.BallSpeed),
            new(4,  "Master Negotiator",  "💶", "Ball cost -5% per level",                   10000,   UpgradeType.BallCost),
            new(5,  "Auto Dropper",       "💶", "Auto-drops a ball every few seconds",       25000,   UpgradeType.AutoDrop),
            new(6,  "Favored Trades",     "💶", "+6% money per level",                       30000,   UpgradeType.MoneyMultiplier),
            new(7,  "Sales Pitch",        "💶", "+4% money per level",                       50000,   UpgradeType.MoneyMultiplier),
            new(8,  "Bouncy",             "💶", "Slightly bouncier pegs per level",          75000,   UpgradeType.BallSpeed),
            new(9,  "Good Investments",   "💶", "+7% money per level",                       100000,   UpgradeType.MoneyMultiplier),
            new(10, "Marketplace Niche",  "💶", "+10% money per level",                      150000,   UpgradeType.MoneyMultiplier),
            new(11, "Discount Dealer",    "💶", "Ball cost -3% per level",                   175000,   UpgradeType.BallCost),
            new(12, "Money Magnet",       "💶", "+6% money per level",                       210000,   UpgradeType.MoneyMultiplier),
            new(13, "Breakthrough!",      "💶", "+7% money per level",                       250000,   UpgradeType.MoneyMultiplier),
            new(14, "Stocks",             "💶", "+9% money per level",                       300000   , UpgradeType.MoneyMultiplier),
            new(15, "Goldman Sachs",      "💶", "+12% money per level",                      400000,  UpgradeType.MoneyMultiplier),
            new(16, "Stable Markets",     "💶", "Slows balls so they hit more pegs",         500000,   UpgradeType.BallSpeed),
            new(17, "Insurance",          "💶", "Refunds 10% of ball cost on land",          650000,   UpgradeType.MoneyMultiplier),
            new(18, "Interest Rate",      "💶", "+7% money per level",                       750000,   UpgradeType.MoneyMultiplier),
            new(19, "Thrifty!",           "💶", "+5% money per level",                       850000,   UpgradeType.MoneyMultiplier),
            new(20, "Jackpot!",           "💶", "+15% money per level",                      1000000,  UpgradeType.MoneyMultiplier),
            new(21, "Banker",             "💶", "+9% money per level",                       1250000,  UpgradeType.MoneyMultiplier),
            new(22, "Swiss Banker",       "💶", "Balls move slightly faster per level",      1500000,  UpgradeType.BallSpeed),
            new(23, "Israeli Investor",   "💶", "+10% money per level",                      2500000,  UpgradeType.MoneyMultiplier),
            new(24, "Money Storm",        "💶", "Grants modest bonus cash per level",        3000000,  UpgradeType.MoneyMultiplier),
            new(25, "Billionaire!",       "💶", "+50% all money — the ultimate upgrade",     8000000,  UpgradeType.MoneyMultiplier),
        };
    }

    // ---- Upgrade Type Enum ----
    public enum UpgradeType
    {
        MoneyMultiplier,
        BallCount,
        BallSpeed,
        BallCost,
        AutoDrop
    }

    // ---- Upgrade Model ----
    public class PlinkoUpgrade(int id, string name, string icon, string desc, double baseCost, UpgradeType type)
    {
        public int Id { get; } = id;
        public string Name { get; } = name;
        public string Icon { get; } = icon;
        public string Description { get; } = desc;
        public double BaseCost { get; } = baseCost;
        public UpgradeType Type { get; } = type;
        public int CurrentLevel { get; set; } = 0;
        public int MaxLevel { get; } = 12;
        public double CurrentCost => BaseCost * Math.Pow(2.5, CurrentLevel);
        public bool IsMaxed => CurrentLevel >= MaxLevel;
        public bool CanAfford(double money) => money >= CurrentCost && !IsMaxed;
    }
}