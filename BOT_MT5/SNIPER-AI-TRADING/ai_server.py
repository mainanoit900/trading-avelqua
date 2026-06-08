#!/usr/bin/env python3
"""
XAUUSD AI Trading Server
========================
Python AI backend for Gold M5 prediction
Communicates with MT5 EA via Named Pipe (Windows) or Socket (Linux/VPS)

Stack:
  - LSTM (PyTorch)  : Direction & momentum prediction
  - XGBoost         : Market regime classification
  - Risk Engine     : Kelly Criterion lot sizing
  - Pipe Server     : Real-time communication with MQL5 EA

Requirements:
  pip install torch xgboost scikit-learn numpy pandas ta requests

"""

import os
import json
import time
import threading
import logging
import struct
import platform
import numpy as np
import pandas as pd
from collections import deque
from datetime import datetime, timezone
from typing import Optional, Dict, Tuple

import torch
import torch.nn as nn
import xgboost as xgb
from sklearn.preprocessing import StandardScaler
import ta  # Technical Analysis library

# ─── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler("ai_server.log")]
)
log = logging.getLogger("XAUUSD_AI")

# ─── Config ────────────────────────────────────────────────────────────────────
PIPE_NAME    = r"\\.\pipe\XAUUSD_AI"   # Windows Named Pipe
SOCKET_HOST  = "127.0.0.1"             # Linux socket fallback
SOCKET_PORT  = 5555
DEVICE       = "cuda" if torch.cuda.is_available() else "cpu"
LOOKBACK     = 100          # bars of input sequence
N_FEATURES   = 20           # features per bar
LSTM_HIDDEN  = 128
LSTM_LAYERS  = 2
MODEL_PATH   = "models/xauusd_lstm.pt"
XGB_PATH     = "models/xauusd_regime.json"
RETRAIN_DAYS = 7            # Retrain every N days
KELLY_FRAC   = 0.25         # Fractional Kelly (conservative)
MAX_KELLY    = 0.05         # Max portfolio fraction per trade

# Auto scalping profile (no manual config)
SCALP_SL_ATR   = 1.0        # Tight SL for short-term
SCALP_TP_ATR   = 1.6        # Quick take-profit (RR ~1.6)
CAPITAL_PER_LOT = 10000.0   # $100 → 0.01 lot base
MAX_RISK_PCT    = 1.2       # Max % balance risked per trade


# ═══════════════════════════════════════════════════════════════════════════════
# LSTM Model Definition
# ═══════════════════════════════════════════════════════════════════════════════
class GoldLSTM(nn.Module):
    """
    Bidirectional LSTM for Gold price direction prediction.
    Input:  (batch, LOOKBACK, N_FEATURES)
    Output: (batch, 3) — logits for [SELL, FLAT, BUY]
    """
    def __init__(self, input_size=N_FEATURES, hidden=LSTM_HIDDEN, layers=LSTM_LAYERS):
        super().__init__()
        self.lstm = nn.LSTM(
            input_size, hidden, layers,
            batch_first=True,
            bidirectional=True,
            dropout=0.3
        )
        self.attention = nn.Sequential(
            nn.Linear(hidden * 2, hidden),
            nn.Tanh(),
            nn.Linear(hidden, 1)
        )
        self.classifier = nn.Sequential(
            nn.Linear(hidden * 2, 64),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(64, 3)  # SELL=0, FLAT=1, BUY=2
        )

    def forward(self, x):
        out, _ = self.lstm(x)            # (B, T, hidden*2)
        attn = self.attention(out)       # (B, T, 1)
        attn = torch.softmax(attn, dim=1)
        context = (out * attn).sum(dim=1)  # (B, hidden*2)
        return self.classifier(context)


# ═══════════════════════════════════════════════════════════════════════════════
# Feature Engineering
# ═══════════════════════════════════════════════════════════════════════════════
class FeatureEngine:
    """Computes 20 technical features from OHLCV data."""

    def __init__(self):
        self.scaler = StandardScaler()
        self._fitted = False

    def compute(self, df: pd.DataFrame) -> np.ndarray:
        """
        Args:
            df: DataFrame with columns [open, high, low, close, volume]
        Returns:
            np.ndarray shape (len(df), N_FEATURES)
        """
        f = pd.DataFrame(index=df.index)

        # Price-based
        f["returns"]     = df["close"].pct_change()
        f["hl_ratio"]    = (df["high"] - df["low"]) / df["close"]
        f["oc_ratio"]    = (df["close"] - df["open"]) / df["open"]

        # RSI
        f["rsi_14"]      = ta.momentum.RSIIndicator(df["close"], 14).rsi() / 100.0

        # MACD
        macd = ta.trend.MACD(df["close"])
        f["macd"]        = macd.macd() / df["close"]
        f["macd_signal"] = macd.macd_signal() / df["close"]
        f["macd_hist"]   = macd.macd_diff() / df["close"]

        # Bollinger Bands
        bb = ta.volatility.BollingerBands(df["close"])
        f["bb_upper"]    = (bb.bollinger_hband() - df["close"]) / df["close"]
        f["bb_lower"]    = (df["close"] - bb.bollinger_lband()) / df["close"]
        f["bb_width"]    = (bb.bollinger_hband() - bb.bollinger_lband()) / df["close"]

        # ATR (normalized)
        atr = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"])
        f["atr_norm"]    = atr.average_true_range() / df["close"]

        # EMA distances
        f["ema8_dist"]   = (df["close"] - df["close"].ewm(span=8).mean()) / df["close"]
        f["ema21_dist"]  = (df["close"] - df["close"].ewm(span=21).mean()) / df["close"]
        f["ema50_dist"]  = (df["close"] - df["close"].ewm(span=50).mean()) / df["close"]

        # Stochastic
        stoch = ta.momentum.StochasticOscillator(df["high"], df["low"], df["close"])
        f["stoch_k"]     = stoch.stoch() / 100.0
        f["stoch_d"]     = stoch.stoch_signal() / 100.0

        # Volume ratio
        f["vol_ratio"]   = df["volume"] / df["volume"].rolling(20).mean()

        # Momentum
        f["mom_10"]      = df["close"].pct_change(10)
        f["mom_20"]      = df["close"].pct_change(20)

        f = f.fillna(0).replace([np.inf, -np.inf], 0)
        arr = f.values.astype(np.float32)

        # Scale features
        if not self._fitted:
            self.scaler.fit(arr)
            self._fitted = True
        return self.scaler.transform(arr)


# ═══════════════════════════════════════════════════════════════════════════════
# Market Regime Classifier (XGBoost)
# ═══════════════════════════════════════════════════════════════════════════════
class RegimeClassifier:
    """
    Classifies market into: 0=ranging, 1=trending_up, 2=trending_down, 3=volatile
    Uses 5 regime features computed from last 20 bars.
    """

    def __init__(self):
        self.model = xgb.XGBClassifier(
            n_estimators=100, max_depth=4,
            learning_rate=0.1, use_label_encoder=False,
            eval_metric="mlogloss", n_jobs=-1
        )
        self._fitted = False

    def regime_features(self, df: pd.DataFrame) -> np.ndarray:
        atr = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"]).average_true_range()
        adx_ind = ta.trend.ADXIndicator(df["high"], df["low"], df["close"])
        adx = adx_ind.adx()
        vol_change = df["close"].pct_change(20).abs()
        close_std  = df["close"].rolling(20).std() / df["close"]

        feats = pd.DataFrame({
            "adx":       adx,
            "atr_norm":  atr / df["close"],
            "vol20":     vol_change,
            "std20":     close_std,
            "rsi":       ta.momentum.RSIIndicator(df["close"]).rsi() / 100.0
        }).fillna(0)
        return feats.values.astype(np.float32)

    def predict(self, df: pd.DataFrame) -> Tuple[str, float]:
        if not self._fitted:
            return "trending", 0.5
        feats = self.regime_features(df)
        probs = self.model.predict_proba(feats[-1:])
        label = int(np.argmax(probs))
        conf  = float(probs[0, label])
        regime_map = {0: "ranging", 1: "trending", 2: "trending", 3: "volatile"}
        return regime_map[label], conf

    def train(self, df: pd.DataFrame, labels: np.ndarray):
        feats = self.regime_features(df)
        self.model.fit(feats[~np.isnan(labels)], labels[~np.isnan(labels)])
        self._fitted = True
        log.info("Regime classifier trained")

    def save(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.model.save_model(path)

    def load(self, path: str):
        if os.path.exists(path):
            self.model.load_model(path)
            self._fitted = True
            log.info(f"Regime model loaded from {path}")


# ═══════════════════════════════════════════════════════════════════════════════
# Risk Engine — Kelly Criterion
# ═══════════════════════════════════════════════════════════════════════════════
class RiskEngine:
    """
    Computes optimal lot size using fractional Kelly Criterion.
    Tracks rolling win/loss statistics (last 50 trades).
    """

    def __init__(self, kelly_frac=KELLY_FRAC, max_frac=MAX_KELLY):
        self.kelly_frac = kelly_frac
        self.max_frac   = max_frac
        self.trades: deque = deque(maxlen=50)  # (pnl, bool won)

    def add_result(self, pnl: float, won: bool):
        self.trades.append((pnl, won))

    def kelly_fraction(self) -> float:
        if len(self.trades) < 10:
            return self.kelly_frac * 0.5  # Conservative before enough data

        wins  = [(p, w) for p, w in self.trades if w]
        loss  = [(p, w) for p, w in self.trades if not w]
        if not wins or not loss:
            return self.kelly_frac * 0.5

        win_rate  = len(wins) / len(self.trades)
        avg_win   = np.mean([abs(p) for p, _ in wins])
        avg_loss  = np.mean([abs(p) for p, _ in loss])
        if avg_loss == 0:
            return self.max_frac

        edge = win_rate * avg_win - (1 - win_rate) * avg_loss
        if edge <= 0:
            return 0.005  # Edge negative — reduce to minimum

        b = avg_win / avg_loss
        kelly = (win_rate - (1 - win_rate) / b)
        fractional = kelly * self.kelly_frac
        return min(max(fractional, 0.005), self.max_frac)

    def compute_lot(self, balance: float, atr_price: float,
                    atr_multiplier: float = 1.5, tick_val: float = 1.0) -> float:
        """
        Compute lot size.
        - atr_price: ATR in price units (e.g. 1.5 for Gold = $1.5)
        - tick_val: $ value of 1 tick (Gold = 1.0 for 0.01 lot)
        """
        frac        = self.kelly_fraction()
        risk_dollar = balance * frac
        sl_price    = atr_price * atr_multiplier
        if sl_price <= 0 or tick_val <= 0:
            return 0.01

        lot = risk_dollar / (sl_price / 0.01 * tick_val)
        lot = round(lot / 0.01) * 0.01  # Snap to 0.01 step
        return max(0.01, min(lot, 2.0))


class AutoLotEngine:
    """
    Fully automatic lot sizing for short-term scalping.
    Scales with balance, confidence, regime, volatility, spread, and equity cushion.
    """

    @staticmethod
    def _num(v, default=0.0) -> float:
        try:
            n = float(v)
            return n if n == n else default
        except Exception:
            return default

    def compute(self, payload: dict, confidence: float, regime: str) -> float:
        balance    = self._num(payload.get("balance"), 1000.0)
        equity     = self._num(payload.get("equity"), balance)
        free_marg  = self._num(payload.get("free_margin"), balance)
        atr        = max(self._num(payload.get("atr"), 1.5), 0.01)
        spread     = self._num(payload.get("spread"), 20.0)
        tick_val   = max(self._num(payload.get("tick_value"), 1.0), 0.01)
        min_lot    = max(self._num(payload.get("min_lot"), 0.01), 0.01)
        max_lot    = max(self._num(payload.get("max_lot"), 2.0), min_lot)
        lot_step   = max(self._num(payload.get("lot_step"), 0.01), 0.01)

        # Base lot from balance tier ($100 = 0.01)
        base_lot = (balance / CAPITAL_PER_LOT) * 0.01
        base_lot = max(base_lot, min_lot)

        # Confidence: stronger signal → modest size boost
        conf_mult = 0.7 + (confidence - 0.5) * 0.9
        conf_mult = min(max(conf_mult, 0.55), 1.4)

        # Regime
        regime_mult = {
            "trending": 1.15,
            "ranging":  0.75,
            "volatile": 0.55,
        }.get(regime, 0.9)

        # Volatility dampener
        vol_mult = 1.0
        if atr > 2.5:
            vol_mult = 0.85
        if atr > 4.0:
            vol_mult = 0.6

        # Spread penalty
        spread_mult = 1.0
        if spread > 25:
            spread_mult = 0.8
        if spread > 35:
            spread_mult = 0.55

        # Equity cushion (floating drawdown)
        eq_mult = 1.0
        if balance > 0:
            eq_ratio = equity / balance
            if eq_ratio < 0.97:
                eq_mult = 0.7
            if eq_ratio < 0.94:
                eq_mult = 0.45

        lot = base_lot * conf_mult * regime_mult * vol_mult * spread_mult * eq_mult

        # Hard risk cap
        risk_dollar = balance * (MAX_RISK_PCT / 100.0)
        sl_price = atr * SCALP_SL_ATR
        risk_lot = risk_dollar / (sl_price / 0.01 * tick_val) if sl_price > 0 else lot
        lot = min(lot, risk_lot)

        # Free margin cap (~20%)
        if free_marg > 0 and balance > 0:
            margin_budget = free_marg * 0.20
            approx_per_lot = balance * 0.002  # rough XAUUSD margin proxy
            if approx_per_lot > 0:
                lot = min(lot, margin_budget / approx_per_lot)

        lot = max(min_lot, min(lot, max_lot))
        lot = round(lot / lot_step) * lot_step
        return round(max(lot, min_lot), 2)


# ═══════════════════════════════════════════════════════════════════════════════
# Main AI Prediction Engine
# ═══════════════════════════════════════════════════════════════════════════════
class GoldAIEngine:
    """Orchestrates LSTM + XGBoost + Risk Engine to produce trading signals."""

    def __init__(self):
        self.feature_engine  = FeatureEngine()
        self.regime_clf      = RegimeClassifier()
        self.risk_engine     = RiskEngine()
        self.auto_lot        = AutoLotEngine()
        self.lstm            = GoldLSTM().to(DEVICE)
        self.lstm.eval()
        self._load_models()

    def _load_models(self):
        if os.path.exists(MODEL_PATH):
            self.lstm.load_state_dict(torch.load(MODEL_PATH, map_location=DEVICE))
            log.info(f"LSTM loaded from {MODEL_PATH}")
        else:
            log.warning("No LSTM model found — using untrained model. Run training first.")
        self.regime_clf.load(XGB_PATH)

    def predict(self, payload: dict) -> dict:
        """
        Main prediction function.
        Returns: {dir, conf, lot, sl, tp, regime}
        """
        try:
            df = self._payload_to_df(payload)
            if df is None or len(df) < LOOKBACK:
                return self._flat_signal("Insufficient data")

            # 1. Regime classification
            regime, regime_conf = self.regime_clf.predict(df)

            # 2. Feature engineering
            features = self.feature_engine.compute(df)
            seq      = features[-LOOKBACK:]   # (LOOKBACK, N_FEATURES)
            tensor   = torch.tensor(seq).unsqueeze(0).to(DEVICE)  # (1, LOOKBACK, F)

            # 3. LSTM prediction
            with torch.no_grad():
                logits = self.lstm(tensor)
                probs  = torch.softmax(logits, dim=-1).cpu().numpy()[0]

            sell_p, flat_p, buy_p = probs[0], probs[1], probs[2]
            log.info(f"LSTM probs — SELL:{sell_p:.3f} FLAT:{flat_p:.3f} BUY:{buy_p:.3f} | Regime:{regime}")

            # 4. Direction — auto scalping thresholds
            auto_mode = str(payload.get("mode", "auto_scalp")).lower()
            thresh = 0.38 if auto_mode == "auto_scalp" else 0.40
            if buy_p > thresh and buy_p > sell_p:
                direction = 1
                confidence = float(buy_p)
            elif sell_p > thresh and sell_p > buy_p:
                direction = -1
                confidence = float(sell_p)
            else:
                return self._flat_signal(f"No strong signal (buy={buy_p:.2f} sell={sell_p:.2f})")

            # 5. Regime adjustment
            min_conf = {"trending": 0.58, "ranging": 0.64, "volatile": 0.72}.get(regime, 0.60)
            if confidence < min_conf:
                return self._flat_signal(f"{regime} — confidence {confidence:.2f} < {min_conf}")
            if regime == "ranging":
                confidence *= 0.92

            # 6. Short-term SL/TP (tight scalping)
            atr_val = float(payload.get("atr", 1.5) or 1.5)
            point   = 0.01  # Gold 2-digit
            sl_pts  = max(int(atr_val * SCALP_SL_ATR / point), 80)
            tp_pts  = max(int(atr_val * SCALP_TP_ATR / point), 100)

            # Boost TP in strong trending + high confidence
            if regime == "trending" and confidence >= 0.70:
                tp_pts = int(tp_pts * 1.15)

            # 7. Auto lot sizing
            lot = self.auto_lot.compute(payload, confidence, regime)

            result = {
                "dir":    direction,
                "conf":   round(confidence, 4),
                "lot":    round(lot, 2),
                "sl":     sl_pts,
                "tp":     tp_pts,
                "regime": regime
            }
            log.info(f"Signal: {result}")
            return result

        except Exception as e:
            log.exception(f"Prediction error: {e}")
            return self._flat_signal(f"Error: {e}")

    def _payload_to_df(self, p: dict) -> Optional[pd.DataFrame]:
        try:
            df = pd.DataFrame({
                "open":   p["open"],
                "high":   p["high"],
                "low":    p["low"],
                "close":  p["close"],
                "volume": p["vol"]
            })
            return df
        except Exception as e:
            log.error(f"Payload parse error: {e}")
            return None

    @staticmethod
    def _flat_signal(reason: str = "") -> dict:
        if reason:
            log.info(f"FLAT signal — {reason}")
        return {"dir": 0, "conf": 0.0, "lot": 0.0, "sl": 0, "tp": 0, "regime": "unknown"}


# ═══════════════════════════════════════════════════════════════════════════════
# Named Pipe Server (Windows) / TCP Socket Server (Linux)
# ═══════════════════════════════════════════════════════════════════════════════
class PipeServer:
    """Handles communication with MT5 EA."""

    def __init__(self, engine: GoldAIEngine):
        self.engine  = engine
        self.running = False

    def handle_request(self, raw: str) -> str:
        try:
            payload  = json.loads(raw)
            result   = self.engine.predict(payload)
            return json.dumps(result)
        except json.JSONDecodeError:
            return json.dumps({"dir": 0, "conf": 0.0, "lot": 0.0, "sl": 0, "tp": 0, "regime": "error"})

    def start_windows(self):
        """Windows Named Pipe server."""
        import win32pipe, win32file, pywintypes
        log.info(f"Starting Named Pipe server: {PIPE_NAME}")
        self.running = True
        while self.running:
            try:
                pipe = win32pipe.CreateNamedPipe(
                    PIPE_NAME,
                    win32pipe.PIPE_ACCESS_DUPLEX,
                    win32pipe.PIPE_TYPE_MESSAGE | win32pipe.PIPE_READMODE_MESSAGE | win32pipe.PIPE_WAIT,
                    1, 65536, 65536, 0, None
                )
                win32pipe.ConnectNamedPipe(pipe, None)
                raw = win32file.ReadFile(pipe, 65536)[1].decode("utf-8")
                response = self.handle_request(raw)
                win32file.WriteFile(pipe, response.encode("utf-8"))
                win32file.CloseHandle(pipe)
            except Exception as e:
                log.error(f"Pipe error: {e}")
                time.sleep(0.1)

    def start_socket(self):
        """Linux TCP socket server (use with port-forwarding or local tunnel)."""
        import socket
        log.info(f"Starting socket server: {SOCKET_HOST}:{SOCKET_PORT}")
        self.running = True
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((SOCKET_HOST, SOCKET_PORT))
        srv.listen(5)
        while self.running:
            try:
                conn, addr = srv.accept()
                with conn:
                    data = conn.recv(65536).decode("utf-8")
                    if data:
                        response = self.handle_request(data)
                        conn.sendall(response.encode("utf-8"))
            except Exception as e:
                log.error(f"Socket error: {e}")
                time.sleep(0.1)
        srv.close()

    def start(self):
        if platform.system() == "Windows":
            t = threading.Thread(target=self.start_windows, daemon=True)
        else:
            t = threading.Thread(target=self.start_socket, daemon=True)
        t.start()
        return t


# ═══════════════════════════════════════════════════════════════════════════════
# Model Training Utilities
# ═══════════════════════════════════════════════════════════════════════════════
def generate_labels(df: pd.DataFrame, horizon: int = 3, threshold: float = 0.0008) -> np.ndarray:
    """
    Generate forward-return labels for supervised training.
    Returns: 0=SELL, 1=FLAT, 2=BUY
    """
    fwd_ret = df["close"].shift(-horizon) / df["close"] - 1
    labels  = np.where(fwd_ret > threshold, 2,
               np.where(fwd_ret < -threshold, 0, 1))
    return labels.astype(np.int64)


def train_lstm(df: pd.DataFrame, epochs: int = 50, lr: float = 1e-3):
    """Train LSTM model on historical data."""
    engine = FeatureEngine()
    feats  = engine.compute(df)
    labels = generate_labels(df)

    # Build sequences
    X, y = [], []
    for i in range(LOOKBACK, len(feats) - 6):
        X.append(feats[i - LOOKBACK:i])
        y.append(labels[i + 3])  # 3-bar forward label (short-term scalp)

    X = torch.tensor(np.array(X), dtype=torch.float32)
    y = torch.tensor(np.array(y), dtype=torch.long)

    dataset = torch.utils.data.TensorDataset(X, y)
    loader  = torch.utils.data.DataLoader(dataset, batch_size=64, shuffle=True)

    model     = GoldLSTM().to(DEVICE)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-5)
    criterion = nn.CrossEntropyLoss()
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    model.train()
    for epoch in range(epochs):
        total_loss = 0.0
        for xb, yb in loader:
            xb, yb = xb.to(DEVICE), yb.to(DEVICE)
            optimizer.zero_grad()
            out  = model(xb)
            loss = criterion(out, yb)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total_loss += loss.item()
        scheduler.step()
        if epoch % 10 == 0:
            log.info(f"Epoch {epoch:3d}/{epochs} | Loss: {total_loss/len(loader):.4f}")

    os.makedirs("models", exist_ok=True)
    torch.save(model.state_dict(), MODEL_PATH)
    log.info(f"LSTM saved to {MODEL_PATH}")
    return model


# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "train":
        # Usage: python ai_server.py train <csv_path>
        # CSV must have columns: open,high,low,close,volume
        csv_path = sys.argv[2] if len(sys.argv) > 2 else "xauusd_m5.csv"
        log.info(f"Training mode — loading {csv_path}")
        df = pd.read_csv(csv_path, parse_dates=True, index_col=0)
        df.columns = [c.lower() for c in df.columns]
        train_lstm(df, epochs=100)

        # Train regime classifier
        engine = GoldAIEngine()
        regime_feats = engine.regime_clf.regime_features(df)
        # Simple rule-based labels for initial training
        adx = ta.trend.ADXIndicator(df["high"], df["low"], df["close"]).adx()
        atr = ta.volatility.AverageTrueRange(df["high"], df["low"], df["close"]).average_true_range()
        vol_pct = atr / df["close"] * 100
        regime_labels = np.where(vol_pct > vol_pct.quantile(0.9), 3,
                         np.where(adx > 25, 1, 0)).astype(np.float32)
        engine.regime_clf.train(df, regime_labels)
        engine.regime_clf.save(XGB_PATH)
        log.info("Training complete")

    else:
        # Server mode
        log.info(f"Starting XAUUSD AI Server | Device: {DEVICE}")
        engine = GoldAIEngine()
        server = PipeServer(engine)
        t = server.start()
        log.info("Server running — waiting for MT5 connections...")
        try:
            t.join()
        except KeyboardInterrupt:
            server.running = False
            log.info("Server stopped")
