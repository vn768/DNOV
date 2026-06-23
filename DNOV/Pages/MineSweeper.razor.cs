using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace DNOV.Pages
{
    public partial class MineSweeper : IAsyncDisposable
    {
        [Inject] IJSRuntime JS { get; set; } = default!;

        private static readonly Dictionary<string, (int rows, int cols, int mines)> Difficulties = new()
        {
            { "easy",   (6,  6,  5)  },
            { "medium", (9,  9,  12) },
            { "hard",   (12, 12, 25) },
        };

        private string difficulty = "easy";
        private int rows = 6;
        private int cols = 6;
        private int totalMines = 5;
        private int cellSize = 32;

        private Cell[,] grid = new Cell[0, 0];
        private bool gameOver = false;
        private bool gameWon = false;
        private bool firstClick = true;
        private int minesRemaining = 5;
        private int elapsedSeconds = 0;

        private System.Timers.Timer? _timer;
        private System.Timers.Timer? _longPressTimer;
        private bool _longPressTriggered = false;

        protected override void OnInitialized()
        {
            NewGame();
        }

        private void SetDifficulty(string diff)
        {
            difficulty = diff;
            NewGame();
        }

        private void NewGame()
        {
            var (r, c, m) = Difficulties[difficulty];
            rows = r;
            cols = c;
            totalMines = m;
            minesRemaining = m;
            gameOver = false;
            gameWon = false;
            firstClick = true;
            elapsedSeconds = 0;
            cellSize = 32;

            grid = new Cell[rows, cols];
            for (int row = 0; row < rows; row++)
                for (int col = 0; col < cols; col++)
                    grid[row, col] = new Cell();

            StopTimer();
            StateHasChanged();
        }

        private void PlaceMines(int safeRow, int safeCol)
        {
            var safeZone = new HashSet<(int, int)>();
            for (int dr = -1; dr <= 1; dr++)
                for (int dc = -1; dc <= 1; dc++)
                {
                    int nr = safeRow + dr, nc = safeCol + dc;
                    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols)
                        safeZone.Add((nr, nc));
                }

            var rng = new Random();
            int placed = 0;
            while (placed < totalMines)
            {
                int r = rng.Next(rows);
                int c = rng.Next(cols);
                if (!grid[r, c].IsMine && !safeZone.Contains((r, c)))
                {
                    grid[r, c].IsMine = true;
                    placed++;
                }
            }

            for (int r = 0; r < rows; r++)
                for (int c = 0; c < cols; c++)
                    if (!grid[r, c].IsMine)
                        grid[r, c].NeighbourMines = CountNeighbourMines(r, c);
        }

        private int CountNeighbourMines(int row, int col)
        {
            int count = 0;
            for (int dr = -1; dr <= 1; dr++)
                for (int dc = -1; dc <= 1; dc++)
                {
                    int nr = row + dr, nc = col + dc;
                    if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr, nc].IsMine)
                        count++;
                }
            return count;
        }

        private void Reveal(int row, int col)
        {
            if (gameOver || gameWon) return;
            if (_longPressTriggered) { _longPressTriggered = false; return; }
            var cell = grid[row, col];
            if (cell.IsRevealed || cell.IsFlagged) return;

            if (firstClick)
            {
                firstClick = false;
                PlaceMines(row, col);
                StartTimer();
            }

            if (cell.IsMine)
            {
                cell.IsRevealed = true;
                cell.IsHit = true;
                gameOver = true;
                RevealAllMines();
                StopTimer();
                return;
            }

            FloodReveal(row, col);
            CheckWin();
        }

        private void FloodReveal(int row, int col)
        {
            if (row < 0 || row >= rows || col < 0 || col >= cols) return;
            var cell = grid[row, col];
            if (cell.IsRevealed || cell.IsFlagged || cell.IsMine) return;

            cell.IsRevealed = true;

            if (cell.NeighbourMines == 0)
            {
                for (int dr = -1; dr <= 1; dr++)
                    for (int dc = -1; dc <= 1; dc++)
                        if (dr != 0 || dc != 0)
                            FloodReveal(row + dr, col + dc);
            }
        }

        private void Flag(int row, int col)
        {
            if (gameOver || gameWon) return;
            var cell = grid[row, col];
            if (cell.IsRevealed) return;

            cell.IsFlagged = !cell.IsFlagged;
            minesRemaining += cell.IsFlagged ? -1 : 1;
        }

        private void RevealAllMines()
        {
            for (int r = 0; r < rows; r++)
                for (int c = 0; c < cols; c++)
                    if (grid[r, c].IsMine && !grid[r, c].IsFlagged)
                        grid[r, c].IsRevealed = true;
        }

        private void CheckWin()
        {
            for (int r = 0; r < rows; r++)
                for (int c = 0; c < cols; c++)
                    if (!grid[r, c].IsMine && !grid[r, c].IsRevealed)
                        return;

            gameWon = true;
            StopTimer();
        }

        private void TouchStart(int row, int col)
        {
            _longPressTriggered = false;
            _longPressTimer?.Dispose();
            _longPressTimer = new System.Timers.Timer(500);
            _longPressTimer.Elapsed += async (_, _) =>
            {
                _longPressTriggered = true;
                _longPressTimer?.Dispose();
                await InvokeAsync(() =>
                {
                    Flag(row, col);
                    StateHasChanged();
                });
            };
            _longPressTimer.AutoReset = false;
            _longPressTimer.Start();
        }

        private void TouchEnd()
        {
            _longPressTimer?.Dispose();
        }

        private void TouchCancel()
        {
            _longPressTimer?.Dispose();
            _longPressTriggered = false;
        }

        private void StartTimer()
        {
            _timer = new System.Timers.Timer(1000);
            _timer.Elapsed += async (_, _) =>
            {
                elapsedSeconds++;
                await InvokeAsync(StateHasChanged);
            };
            _timer.AutoReset = true;
            _timer.Start();
        }

        private void StopTimer()
        {
            _timer?.Stop();
            _timer?.Dispose();
            _timer = null;
        }

        private string GetCellClass(Cell cell)
        {
            if (cell.IsHit) return "mine-hit";
            if (cell.IsMine && cell.IsRevealed) return "mine-revealed";
            if (cell.IsRevealed && cell.NeighbourMines > 0) return $"revealed n{cell.NeighbourMines}";
            if (cell.IsRevealed) return "revealed";
            if (cell.IsFlagged) return "flagged";
            return "hidden";
        }

        private string GetCellContent(Cell cell)
        {
            if (cell.IsHit || (cell.IsMine && cell.IsRevealed))
                return "<img src='images/pgit-logo.png' style='width:20px;height:20px;object-fit:contain;' />";
            if (cell.IsFlagged) return "🚩";
            if (!cell.IsRevealed) return "";
            if (cell.NeighbourMines == 0) return "";
            return cell.NeighbourMines.ToString();
        }

        public ValueTask DisposeAsync()
        {
            StopTimer();
            _longPressTimer?.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    public class Cell
    {
        public bool IsMine { get; set; }
        public bool IsRevealed { get; set; }
        public bool IsFlagged { get; set; }
        public bool IsHit { get; set; }
        public int NeighbourMines { get; set; }
    }
}