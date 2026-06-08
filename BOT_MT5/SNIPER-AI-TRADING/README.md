# XAUUSD AI Trading Bot — Full Stack Guide

## Files
- `XAUUSD_AI_Bot.mq5` — MT5 Expert Advisor (MQL5)
- `ai_server.py`       — Python AI Prediction Server
- `requirements.txt`   — Python dependencies

---

## Architecture
```
MT5 (EA) ──Named Pipe──> Python Server ──> [LSTM + XGBoost] ──> Signal JSON ──> EA Executes
```

---

## Setup Steps

### 1. Python Server (VPS or local)
```bash
pip install -r requirements.txt

# Train LSTM on historical M5 data (CSV: open,high,low,close,volume)
python ai_server.py train xauusd_m5_5years.csv

# Start server
python ai_server.py
```

### 2. MT5 EA Setup
1. Copy `XAUUSD_AI_Bot.mq5` → MetaTrader 5 / MQL5 / Experts /
2. Compile in MetaEditor (F7)
3. Attach to XAUUSD M5 chart
4. Set inputs:
   - PipeName: `\\.\pipe\XAUUSD_AI`
   - RiskPercentage: 1.0
   - MinConfidence: 0.65
   - MaxSpreadPoints: 30

### 3. Key Parameters to Tune
| Parameter        | Default | Notes                                |
|-----------------|---------|--------------------------------------|
| RiskPercentage  | 1.0%    | Lower for live trading initially     |
| MinConfidence   | 0.65    | Higher = fewer but better signals    |
| ATR_SL_Multi    | 1.5×    | SL distance in ATR multiples         |
| ATR_TP_Multi    | 2.5×    | TP distance (RR = 1:1.67)            |
| MaxDailyLoss    | 5.0%    | Hard stop for daily drawdown         |
| MaxSpreadPoints | 30      | Skip if spread > 3 pips              |

---

## Signal Flow
1. Every new M5 candle → EA sends OHLCV JSON to Python pipe
2. Python computes 20 features (RSI, MACD, BB, ATR, EMAs, etc.)
3. XGBoost classifies regime (trending / ranging / volatile)
4. LSTM predicts direction + confidence
5. Kelly Criterion calculates lot size
6. EA receives signal, validates, executes

---

## Recommended VPS Setup ($200+/month budget)
- **MT5 VPS**: Contabo CX22 ($6.99/mo) — Windows Server
- **AI Server**: RunPod A100 on-demand ($0.79/hr) for weekly retrain
  - OR Hetzner Cloud (AX42) for CPU inference ($50/mo)
- **Monitoring**: Grafana + Prometheus (free) + Telegram Bot

---

## Weekly Retraining (Cron)
```bash
# Add to crontab: every Sunday 02:00
0 2 * * 0 cd /app && python ai_server.py train latest_data.csv
```

---

## Risk Warning
This is an experimental AI trading system. Always test on a Demo account for
minimum 3-6 months before live trading. AI models do not guarantee profit.
Past performance does not predict future results. Understand your risk.
