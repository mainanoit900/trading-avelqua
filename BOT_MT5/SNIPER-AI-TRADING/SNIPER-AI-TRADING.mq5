//+------------------------------------------------------------------+
//|  SNIPER-AI-TRADING.mq5                                           |
//|  Fully Automatic AI Gold Scalper — zero manual setup             |
//|  MQL5 <-> Python AI Server | Auto Lot | Short-term profit focus  |
//+------------------------------------------------------------------+
#property copyright "SNIPER AI Trading"
#property version   "3.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\SymbolInfo.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\AccountInfo.mqh>

CTrade         trade;
CSymbolInfo    symbolInfo;
CPositionInfo  posInfo;
CAccountInfo   accountInfo;

//--- Auto config (no user inputs — attach chart and run)
const string   PIPE_NAME       = "\\\\.\\pipe\\XAUUSD_AI";
const int      PIPE_TIMEOUT_MS = 3000;
const int      BARS_LOOKBACK   = 100;
const int      ATR_PERIOD      = 14;
const bool     USE_TRAILING    = true;
const double   TRAIL_ATR_MULT  = 0.8;
const double   MAX_DAILY_LOSS  = 4.0;    // % of day-start balance
const int      MAX_SPREAD_PTS  = 35;     // auto skip wide spread
const bool     FILTER_SESSION  = true;   // London + NY overlap only

//--- Globals
int      atrHandle;
double   atrBuffer[];
double   dailyStartBalance;
datetime lastBarTime    = 0;
ulong    magicNumber    = 0;
int      totalTrades    = 0;
double   totalPnL       = 0.0;
int      winCount       = 0;

struct AISignal {
   int    direction;
   double confidence;
   double lotSize;
   double slPoints;
   double tpPoints;
   string regime;
};

//+------------------------------------------------------------------+
ulong AutoMagicNumber()
{
   ulong login = (ulong)AccountInfoInteger(ACCOUNT_LOGIN);
   return 20240601UL + (login % 900000UL);
}

//+------------------------------------------------------------------+
int OnInit()
{
   magicNumber = AutoMagicNumber();
   trade.SetExpertMagicNumber((long)magicNumber);
   trade.SetDeviationInPoints(25);
   trade.SetTypeFilling(ORDER_FILLING_IOC);

   symbolInfo.Name(Symbol());
   symbolInfo.RefreshRates();

   atrHandle = iATR(Symbol(), PERIOD_M5, ATR_PERIOD);
   if(atrHandle == INVALID_HANDLE) {
      Print("SNIPER-AI: ATR init failed");
      return INIT_FAILED;
   }
   ArraySetAsSeries(atrBuffer, true);

   dailyStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   Print("SNIPER-AI AUTO | Login:", AccountInfoInteger(ACCOUNT_LOGIN),
         " Magic:", magicNumber, " Balance:", dailyStartBalance);

   EventSetTimer(60);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(atrHandle);
   EventKillTimer();
   PrintStats();
}

//+------------------------------------------------------------------+
void OnTick()
{
   symbolInfo.RefreshRates();

   datetime currentBar = iTime(Symbol(), PERIOD_M5, 0);
   if(currentBar == lastBarTime) return;
   lastBarTime = currentBar;

   if(!IsSymbolTradable())   return;
   if(IsDailyLossBreached()) return;
   if(FILTER_SESSION && !IsValidSession()) return;

   if(CopyBuffer(atrHandle, 0, 0, ATR_PERIOD + 1, atrBuffer) < ATR_PERIOD) return;
   double currentATR = atrBuffer[1];

   AISignal signal;
   if(!GetAISignal(signal, currentATR)) {
      Print("SNIPER-AI: signal unavailable");
      return;
   }

   if(signal.confidence < AutoMinConfidence(signal.regime)) return;

   double spreadPoints = symbolInfo.Spread();
   if(spreadPoints > MaxSpreadAuto()) {
      Print("SNIPER-AI: spread too wide ", spreadPoints);
      return;
   }

   if(signal.direction == 1 && !HasOpenPosition(POSITION_TYPE_BUY)) {
      CloseAllPositions(POSITION_TYPE_SELL);
      double lot = FinalLot(signal.lotSize, signal.confidence, currentATR);
      double slDist = SlDistance(signal.slPoints, currentATR);
      double tpDist = TpDistance(signal.tpPoints, currentATR);
      OpenBuy(lot, symbolInfo.Ask() - slDist, symbolInfo.Ask() + tpDist, signal);
   }
   else if(signal.direction == -1 && !HasOpenPosition(POSITION_TYPE_SELL)) {
      CloseAllPositions(POSITION_TYPE_BUY);
      double lot = FinalLot(signal.lotSize, signal.confidence, currentATR);
      double slDist = SlDistance(signal.slPoints, currentATR);
      double tpDist = TpDistance(signal.tpPoints, currentATR);
      OpenSell(lot, symbolInfo.Bid() + slDist, symbolInfo.Bid() - tpDist, signal);
   }

   if(USE_TRAILING) ManageTrailingStop(currentATR);
}

//+------------------------------------------------------------------+
double AutoMinConfidence(const string regime)
{
   if(regime == "trending") return 0.58;
   if(regime == "ranging")  return 0.64;
   if(regime == "volatile") return 0.72;
   return 0.60;
}

//+------------------------------------------------------------------+
int MaxSpreadAuto()
{
   double point = symbolInfo.Point();
   if(point <= 0) return MAX_SPREAD_PTS;
   // ~3.5 pips default, widen slightly on high ATR (volatile gold)
   double atr = atrBuffer[1];
   if(atr > 3.0) return MAX_SPREAD_PTS + 10;
   return MAX_SPREAD_PTS;
}

//+------------------------------------------------------------------+
double SlDistance(const double aiPts, const double atr)
{
   double dist = aiPts > 0 ? aiPts * symbolInfo.Point() : atr * 1.0;
   return MathMax(dist, symbolInfo.Point() * 80);
}

//+------------------------------------------------------------------+
double TpDistance(const double aiPts, const double atr)
{
   double dist = aiPts > 0 ? aiPts * symbolInfo.Point() : atr * 1.6;
   return MathMax(dist, symbolInfo.Point() * 100);
}

//+------------------------------------------------------------------+
double FinalLot(const double aiLot, const double conf, const double atr)
{
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity   = AccountInfoDouble(ACCOUNT_EQUITY);
   double freeMarg = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double tickVal  = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_SIZE);
   double lotStep  = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_STEP);
   double minLot   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MIN);
   double maxLot   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MAX);

   // Base: ~$100 per 0.01 lot (auto scale with balance)
   double baseLot = (balance / 10000.0) * 0.01;
   baseLot = MathMax(baseLot, minLot);

   // Confidence boost: stronger signal → slightly larger (capped)
   double confMult = 0.75 + (conf - 0.5) * 0.8;
   confMult = MathMax(0.6, MathMin(confMult, 1.35));

   // Equity cushion: reduce if floating drawdown
   double eqMult = 1.0;
   if(balance > 0 && equity < balance * 0.97) eqMult = 0.7;
   if(balance > 0 && equity < balance * 0.94) eqMult = 0.5;

   // ATR volatility: high vol → smaller lot
   double atrMult = 1.0;
   if(atr > 2.5) atrMult = 0.85;
   if(atr > 4.0) atrMult = 0.65;

   double lot = aiLot > 0 ? aiLot : baseLot;
   lot = lot * confMult * eqMult * atrMult;

   // Hard risk cap: max 1.2% balance per trade at 1×ATR SL
   double riskCap = balance * 0.012;
   double slVal   = atr * 1.0;
   if(tickVal > 0 && slVal > 0 && tickSize > 0) {
      double maxRiskLot = riskCap / (slVal / tickSize * tickVal);
      lot = MathMin(lot, maxRiskLot);
   }

   // Margin safety: never use > 25% free margin
   double marginReq = 0;
   if(OrderCalcMargin(ORDER_TYPE_BUY, Symbol(), 1.0, symbolInfo.Ask(), marginReq) && marginReq > 0) {
      double marginCap = (freeMarg * 0.25) / marginReq;
      lot = MathMin(lot, marginCap);
   }

   lot = MathMin(lot, maxLot);
   lot = MathMax(lot, minLot);
   if(lotStep > 0) lot = MathRound(lot / lotStep) * lotStep;
   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
bool GetAISignal(AISignal &sig, const double atr)
{
   string payload = BuildFeaturePayload(atr);
   if(payload == "") return false;

   string response = PipeSendReceive(payload);
   if(response == "" || response == "ERROR") return false;

   sig.direction  = (int)ParseJSONDouble(response, "dir");
   sig.confidence = ParseJSONDouble(response, "conf");
   sig.lotSize    = ParseJSONDouble(response, "lot");
   sig.slPoints   = ParseJSONDouble(response, "sl");
   sig.tpPoints   = ParseJSONDouble(response, "tp");
   sig.regime     = ParseJSONString(response, "regime");
   return sig.direction != 0;
}

//+------------------------------------------------------------------+
string BuildFeaturePayload(const double atr)
{
   int bars = BARS_LOOKBACK;
   if(Bars(Symbol(), PERIOD_M5) < bars + 5) return "";

   double open[], high[], low[], close[];
   long   volume[];
   ArraySetAsSeries(open, true);
   ArraySetAsSeries(high, true);
   ArraySetAsSeries(low, true);
   ArraySetAsSeries(close, true);
   ArraySetAsSeries(volume, true);

   if(CopyOpen(Symbol(),  PERIOD_M5, 1, bars, open)   < bars) return "";
   if(CopyHigh(Symbol(),  PERIOD_M5, 1, bars, high)   < bars) return "";
   if(CopyLow(Symbol(),   PERIOD_M5, 1, bars, low)    < bars) return "";
   if(CopyClose(Symbol(), PERIOD_M5, 1, bars, close)  < bars) return "";
   if(CopyTickVolume(Symbol(), PERIOD_M5, 1, bars, volume) < bars) return "";

   string oStr = "[", hStr = "[", lStr = "[", cStr = "[", vStr = "[";
   for(int i = bars - 1; i >= 0; i--) {
      oStr += DoubleToString(open[i],  2) + (i > 0 ? "," : "]");
      hStr += DoubleToString(high[i],  2) + (i > 0 ? "," : "]");
      lStr += DoubleToString(low[i],   2) + (i > 0 ? "," : "]");
      cStr += DoubleToString(close[i], 2) + (i > 0 ? "," : "]");
      vStr += IntegerToString(volume[i]) + (i > 0 ? "," : "]");
   }

   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
   double freeMarg  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double spread    = symbolInfo.Spread();
   double minLot    = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MIN);
   double maxLot    = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_MAX);
   double lotStep   = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_STEP);
   double tickVal   = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_VALUE);
   string session   = GetCurrentSession();
   string mode      = "auto_scalp";

   string json = "{";
   json += "\"sym\":\"" + Symbol() + "\",";
   json += "\"tf\":\"M5\",";
   json += "\"mode\":\"" + mode + "\",";
   json += "\"open\":" + oStr + ",";
   json += "\"high\":" + hStr + ",";
   json += "\"low\":"  + lStr + ",";
   json += "\"close\":" + cStr + ",";
   json += "\"vol\":" + vStr + ",";
   json += "\"atr\":" + DoubleToString(atr, 5) + ",";
   json += "\"spread\":" + DoubleToString(spread, 1) + ",";
   json += "\"balance\":" + DoubleToString(balance, 2) + ",";
   json += "\"equity\":" + DoubleToString(equity, 2) + ",";
   json += "\"free_margin\":" + DoubleToString(freeMarg, 2) + ",";
   json += "\"min_lot\":" + DoubleToString(minLot, 2) + ",";
   json += "\"max_lot\":" + DoubleToString(maxLot, 2) + ",";
   json += "\"lot_step\":" + DoubleToString(lotStep, 2) + ",";
   json += "\"tick_value\":" + DoubleToString(tickVal, 4) + ",";
   json += "\"session\":\"" + session + "\"";
   json += "}";
   return json;
}

//+------------------------------------------------------------------+
string PipeSendReceive(const string data)
{
   int pipe = FileOpen(PIPE_NAME, FILE_READ | FILE_WRITE | FILE_BIN | FILE_ANSI);
   if(pipe == INVALID_HANDLE) {
      Print("SNIPER-AI: pipe connect failed — start ai_server.py");
      return "ERROR";
   }

   uchar outBuf[];
   StringToCharArray(data, outBuf, 0, StringLen(data));
   FileWriteArray(pipe, outBuf);

   string response = "";
   ulong  startMs  = GetTickCount64();
   while(GetTickCount64() - startMs < (ulong)PIPE_TIMEOUT_MS) {
      if(FileTell(pipe) < FileSize(pipe)) {
         uchar inBuf[];
         uint  bytes = (uint)FileReadArray(pipe, inBuf, 0, 4096);
         if(bytes > 0) {
            response = CharArrayToString(inBuf, 0, bytes);
            break;
         }
      }
      Sleep(50);
   }
   FileClose(pipe);
   return response;
}

//+------------------------------------------------------------------+
void OpenBuy(double lot, double sl, double tp, const AISignal &sig)
{
   sl = NormalizeDouble(sl, symbolInfo.Digits());
   tp = NormalizeDouble(tp, symbolInfo.Digits());
   string comment = StringFormat("SNIPER|%.0f%%|%s", sig.confidence * 100, sig.regime);
   if(trade.Buy(lot, Symbol(), 0, sl, tp, comment)) {
      Print("BUY ", lot, " SL:", sl, " TP:", tp, " conf:", sig.confidence);
      totalTrades++;
   } else {
      Print("BUY fail ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
void OpenSell(double lot, double sl, double tp, const AISignal &sig)
{
   sl = NormalizeDouble(sl, symbolInfo.Digits());
   tp = NormalizeDouble(tp, symbolInfo.Digits());
   string comment = StringFormat("SNIPER|%.0f%%|%s", sig.confidence * 100, sig.regime);
   if(trade.Sell(lot, Symbol(), 0, sl, tp, comment)) {
      Print("SELL ", lot, " SL:", sl, " TP:", tp, " conf:", sig.confidence);
      totalTrades++;
   } else {
      Print("SELL fail ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
void ManageTrailingStop(const double atr)
{
   double trailDist = atr * TRAIL_ATR_MULT;
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != (long)magicNumber) continue;
      if(posInfo.Symbol() != Symbol()) continue;

      double curSL  = posInfo.StopLoss();
      double openPx = posInfo.PriceOpen();

      if(posInfo.PositionType() == POSITION_TYPE_BUY) {
         double bid   = symbolInfo.Bid();
         double newSL = bid - trailDist;
         if(newSL > curSL + symbolInfo.Point() && newSL > openPx)
            trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
      }
      else if(posInfo.PositionType() == POSITION_TYPE_SELL) {
         double ask   = symbolInfo.Ask();
         double newSL = ask + trailDist;
         if((curSL == 0 || newSL < curSL - symbolInfo.Point()) && newSL < openPx)
            trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
      }
   }
}

//+------------------------------------------------------------------+
void CloseAllPositions(const int type)
{
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() != (long)magicNumber) continue;
      if(posInfo.Symbol() != Symbol()) continue;
      if(type != -1 && (int)posInfo.PositionType() != type) continue;
      double pnl = posInfo.Profit();
      trade.PositionClose(posInfo.Ticket());
      totalPnL += pnl;
      if(pnl > 0) winCount++;
   }
}

//+------------------------------------------------------------------+
bool HasOpenPosition(const ENUM_POSITION_TYPE type)
{
   for(int i = 0; i < PositionsTotal(); i++) {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Magic() == (long)magicNumber && posInfo.Symbol() == Symbol()
         && posInfo.PositionType() == type) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
bool IsDailyLossBreached()
{
   if(dailyStartBalance <= 0) return false;
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double loss   = (dailyStartBalance - equity) / dailyStartBalance * 100.0;
   if(loss >= MAX_DAILY_LOSS) {
      Print("SNIPER-AI: daily loss limit ", DoubleToString(loss, 2), "% — stopped");
      CloseAllPositions(-1);
      return true;
   }
   return false;
}

//+------------------------------------------------------------------+
bool IsValidSession()
{
   MqlDateTime t;
   TimeToStruct(TimeGMT(), t);
   int hm = t.hour * 100 + t.min;
   // London open → NY close (08:00–21:00 UTC), skip Asian low-vol
   return (hm >= 800 && hm <= 2100);
}

//+------------------------------------------------------------------+
bool IsSymbolTradable()
{
   if(!symbolInfo.IsSynchronized()) return false;
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED)) return false;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) return false;
   return true;
}

//+------------------------------------------------------------------+
string GetCurrentSession()
{
   MqlDateTime t;
   TimeToStruct(TimeGMT(), t);
   int h = t.hour;
   if(h >= 8  && h < 13) return "london";
   if(h >= 13 && h < 17) return "overlap";
   if(h >= 17 && h < 21) return "ny";
   return "asian";
}

//+------------------------------------------------------------------+
void OnTimer()
{
   static datetime lastDay = 0;
   datetime today = StringToTime(TimeToString(TimeCurrent(), TIME_DATE));
   if(today != lastDay) {
      dailyStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      lastDay = today;
   }
}

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &req,
                        const MqlTradeResult &res)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD) {
      if(trans.deal_type == DEAL_TYPE_BUY || trans.deal_type == DEAL_TYPE_SELL) {
         double profit = HistoryDealGetDouble(trans.deal, DEAL_PROFIT);
         if(profit != 0) {
            totalPnL += profit;
            if(profit > 0) winCount++;
         }
      }
   }
}

//+------------------------------------------------------------------+
void PrintStats()
{
   Print("=== SNIPER-AI SESSION ===");
   Print("Trades: ", totalTrades, " Wins: ", winCount);
   if(totalTrades > 0)
      Print("Win rate: ", DoubleToString((double)winCount / totalTrades * 100.0, 1), "%");
   Print("PnL: ", DoubleToString(totalPnL, 2));
}

//+------------------------------------------------------------------+
double ParseJSONDouble(const string json, const string key)
{
   string search = "\"" + key + "\":";
   int pos = StringFind(json, search);
   if(pos < 0) return 0.0;
   pos += StringLen(search);
   return StringToDouble(StringSubstr(json, pos, 24));
}

//+------------------------------------------------------------------+
string ParseJSONString(const string json, const string key)
{
   string search = "\"" + key + "\":\"";
   int pos = StringFind(json, search);
   if(pos < 0) return "";
   pos += StringLen(search);
   int end = StringFind(json, "\"", pos);
   if(end < 0) return "";
   return StringSubstr(json, pos, end - pos);
}
//+------------------------------------------------------------------+
