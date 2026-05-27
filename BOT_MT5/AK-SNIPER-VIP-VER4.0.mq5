//+------------------------------------------------------------------+
//|                                     Ultima_Pro_Clone_Grid.mq5    |
//|                               Recreated based on User Inputs     |
//|                             Fixed: Persistent Grid Management    |
//+------------------------------------------------------------------+
#property copyright "Custom Grid System & Dashboard"
#property version   "1.69"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include "AvelquaBotClose.mqh"

CTrade         trade;
CPositionInfo  pos; // ตัวแปรหลักของระบบ

//+------------------------------------------------------------------+
//| SETTINGS: ล็อคสิทธิ์การใช้งาน (วันหมดอายุ, เลขบัญชี)                     |
//+------------------------------------------------------------------+
const datetime InpExpiryDate = D'2027.12.30 23:59:59'; // วันหมดอายุ

// ใส่เลขพอร์ตเพื่อล็อค (รองรับหลายพอร์ต) หรือ ใส่ 0 เพื่อให้ใช้ได้ทุกพอร์ต
long AllowedAccounts[] = {0};

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
//--- โหมดทยอยปิดพอร์ต (Soft Close) ---
input bool     InpSoftClose            = false;      // โหมด Soft Close (รวบกำไรไม้ค้างแล้วหยุด ไม่เปิดไม้ใหม่)

input double   InpLotSize              = 0.02;       // Lot Size (เริ่มเปิดไม้แรก)
input double   InpLotPlus              = 0.02;       // Lot Plus (ระบบบวก Lot ไม่ใช่คูณ)
input int      InpPipStep              = 345;        // Pip Step (point)
input int      InpTakeProfitAverage    = 100;        // Take Profit Average (point)
input double   InpTrailingStartMoney   = 8.0;        // Trailing Start ($)
input double   InpTrailingStopMoney    = 5.0;        // Trailing Stop ($)
input double   InpCutLossPct           = 100.0;      // Cut Loss (%)

//--- Daily Limit & Server Protection ---
input double   InpDailyProfitTarget    = 0.0;      // Daily Profit Target ($) [0 = ไม่ใช้งาน]
input double   InpDailyLossLimit       = 0.0;      // Daily Loss Limit ($) [0 = ไม่ใช้งาน]
input int      InpMaxDailyCommands     = 30000;      // ลิมิตส่งคำสั่งเข้า Server ต่อวัน (กันโบรกแบน)

//--- Time Filter (อิงเวลาประเทศไทย UTC+7) 3 Sessions ---
input bool     InpUseTimeFilter        = false;        // เปิดใช้งานระบบแบ่งเวลาเทรด
input bool     InpUseSession1          = false;        // เปิดใช้งาน Session 1
input string   InpStartTime1           = "03:00";    // Start Time 1 (HH:MM)
input string   InpStopTime1            = "06:00";    // Stop Time 1 (HH:MM)
input bool     InpUseSession2          = false;        // เปิดใช้งาน Session 2
input string   InpStartTime2           = "11:00";    // Start Time 2 (HH:MM)
input string   InpStopTime2            = "14:00";    // Stop Time 2 (HH:MM)
input bool     InpUseSession3          = false;      // เปิดใช้งาน Session 3
input string   InpStartTime3           = "19:00";    // Start Time 3 (HH:MM)
input string   InpStopTime3            = "23:55";    // Stop Time 3 (HH:MM)

//--- Sideway & Trend Filter (แยกเปิด/ปิดได้ และปรับให้หลวมขึ้น) ---
input bool     InpUseTrendFilter       = false;       // เปิดใช้งานระบบกรองไม้แรกโดยรวม
// 1. ADX Filter
input bool     InpUseADXFilter         = false;       // [แยก] เปิดใช้เงื่อนไข ADX
input int      InpAdxPeriod            = 14;          // ADX Period
input double   InpAdxThreshold         = 35.0;        // ADX Threshold (ปรับจาก 25 เป็น 35 ให้หลวมขึ้น)
// 2. BB + ATR Filter
input bool     InpUseBBFilter          = false;      // [แยก] เปิดใช้เงื่อนไข Bollinger Bands
input int      InpBbPeriod             = 20;          // Bollinger Bands Period
input double   InpBbAtrMultiplier      = 5.0;         // BB แคบ (ปรับจาก 2.0 เป็น 5.0 ยอมให้สวิงได้กว้างขึ้น)
input int      InpAtrPeriod            = 14;          // ATR Period
// 3. EMA Filter
input bool     InpUseEMAFilter         = false;      // [แยก] เปิดใช้เงื่อนไข EMA
input int      InpEmaPeriod            = 200;         // EMA Period
input double   InpEmaFlatPoints        = 300.0;      // EMA ไซด์เวย์ (ห้ามชันเกินกี่ Point ใน 3 แท่ง)
// 4. Breakout Emergency Stop
input int      InpBreakoutBars         = 30;          // จำนวนแท่งสำหรับหา Breakout High/Low

input ulong    InpMagicNumber          = 2122025;    // Magic Number

//--- News Filter Settings (Forex Factory) ---
input bool     InpUseNewsFilter        = false;      // เปิดใช้งานระบบหลบข่าว (ต้อง Allow WebRequest)
input int      InpBrokerGMT            = 3;          // Broker GMT Offset (เช่น XM หน้าหนาว=2, หน้าร้อน=3)
input string   InpNewsCurrency         = "AUTO";     // สกุลเงิน (AUTO = อัตโนมัติตามกราฟ, ALL = หลบทุกข่าว)
// ข่าวกล่องแดง - High Impact
input bool     InpAvoidRed             = true;       // หลบข่าวกล่องแดง (High)
input int      InpRedMinsBefore        = 60;         // หยุดเทรดก่อนข่าวแดง (นาที)
input int      InpRedMinsAfter         = 60;         // กลับมาเทรดหลังข่าวแดง (นาที)
// ข่าวกล่องส้ม - Medium Impact
input bool     InpAvoidOrange          = true;       // หลบข่าวกล่องส้ม (Medium)
input int      InpOrangeMinsBefore     = 30;         // หยุดเทรดก่อนข่าวส้ม (นาที)
input int      InpOrangeMinsAfter      = 30;         // กลับมาเทรดหลังข่าวส้ม (นาที)

//--- Global Variables
double highest_profit_buy = 0.0;
double highest_profit_sell = 0.0;
int    last_thai_day = -1;
int    last_thai_week = -1; // เก็บค่าสัปดาห์
bool   daily_limit_hit = false;
double max_drawdown_val = 0.0; // เก็บค่า Max Drawdown รอบปัจจุบัน (Session)

// ตัวแปรเก็บค่า All Time Max Drawdown
double all_time_max_dd_money = 0.0;
double all_time_max_dd_pct = 0.0;
string gv_dd_money_name = "";
string gv_dd_pct_name = "";

datetime last_trade_time = 0; // เก็บเวลาที่เปิดไม้ล่าสุด เพื่อป้องกันการเบิ้ลไม้ระดับ Local
datetime last_diag_log_time = 0; // หน่วง log diagnostic ไม่ให้ spam Experts/Journal

// ตัวแปรเก็บสถิติคำสั่ง Server
int daily_command_count = 0;
int weekly_command_count = 0; // ตัวแปรเก็บคำสั่งรายสัปดาห์

// ตัวแปรสำหรับ News Filter
bool is_news_pausing = false;
datetime last_news_fetch = 0;

struct NewsEvent {
   string country;
   string impact;
   datetime broker_time;
};
NewsEvent NewsData[];

//--- Indicator Handles
int handle_adx, handle_bb, handle_atr, handle_ema;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   if (TimeCurrent() > InpExpiryDate)
    {
       Alert("Trial period expired! (หมดอายุการใช้งาน)");
       return(INIT_FAILED);
    }
// --- ส่วนตรวจสอบเลขบัญชี (รองรับหลายบัญชี) ---
   bool isAllowed = false;
   int totalAccounts = ArraySize(AllowedAccounts);
   long currentAccount = AccountInfoInteger(ACCOUNT_LOGIN);

   for(int i=0; i < totalAccounts; i++)
   {
      // ถ้าเจอเลขพอร์ตที่ตรงกัน หรือถ้าในรายการมีเลข 0 (แปลว่าอนุญาตทุกพอร์ต)
      if(currentAccount == AllowedAccounts[i] || AllowedAccounts[i] == 0)
      {
         isAllowed = true;
         break;
      }
   }

   if(!isAllowed)
   {
      Alert("เลขบัญชีไม่ถูกต้อง! EA นี้ไม่อนุญาตให้ใช้งานกับบัญชี: ", currentAccount);
      return(INIT_FAILED);
   }
   
   // --- ส่วนตรวจสอบโบรกเกอร์ (XM หรือ MH Markets) ---
   string brokerName = AccountInfoString(ACCOUNT_COMPANY);
   StringToUpper(brokerName); // แปลงเป็นตัวพิมพ์ใหญ่เพื่อความแม่นยำในการตรวจ

   // ตรวจหาคำว่า "XM" หรือ "MH MARKETS" ในชื่อบริษัทโบรกเกอร์
   if(StringFind(brokerName, "XM") < 0 && StringFind(brokerName, "MOHICANS MARKETS LTD") < 0)
   {
      Alert("โบรกเกอร์ไม่ถูกต้อง! อนุญาตเฉพาะ XM และ MH Markets เท่านั้น (โบรกปัจจุบัน: ", brokerName, ")");
      return(INIT_FAILED);
   }
   // =========================================================

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(30);
   
   // สร้างชื่อตัวแปรเก็บ All Time DD แบบผูกกับ Magic Number และ คู่เงิน
   gv_dd_money_name = "MAX_DD_MONEY_" + IntegerToString(InpMagicNumber) + "_" + _Symbol;
   gv_dd_pct_name = "MAX_DD_PCT_" + IntegerToString(InpMagicNumber) + "_" + _Symbol;
   
   // โหลดค่า All Time DD เก่ากลับมา (ถ้ามีบันทึกไว้ในระบบ)
   if(GlobalVariableCheck(gv_dd_money_name)) all_time_max_dd_money = GlobalVariableGet(gv_dd_money_name);
   if(GlobalVariableCheck(gv_dd_pct_name)) all_time_max_dd_pct = GlobalVariableGet(gv_dd_pct_name);
   
   // Initialize Indicators
   handle_adx = iADX(_Symbol, PERIOD_CURRENT, InpAdxPeriod);
   handle_bb  = iBands(_Symbol, PERIOD_CURRENT, InpBbPeriod, 0, 2.0, PRICE_CLOSE);
   handle_atr = iATR(_Symbol, PERIOD_CURRENT, InpAtrPeriod);
   handle_ema = iMA(_Symbol, PERIOD_CURRENT, InpEmaPeriod, 0, MODE_EMA, PRICE_CLOSE);
   
   if(handle_adx == INVALID_HANDLE || handle_bb == INVALID_HANDLE || handle_atr == INVALID_HANDLE || handle_ema == INVALID_HANDLE)
     {
      Print("Error initializing indicators");
      return(INIT_FAILED);
     }
     
   // แจ้งเตือน WebRequest สำหรับดึงข่าว
   if(InpUseNewsFilter)
   {
      Print("News Filter Enabled: โปรดตรวจสอบว่าได้เพิ่ม https://nfs.faireconomy.media ใน Tools > Options > Expert Advisors (Allow WebRequest) แล้ว");
   }
     
   UpdateDashboard();
   
   AvelquaBotCloseOnInit();
     
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   AvelquaBotCloseOnDeinit();
   IndicatorRelease(handle_adx);
   IndicatorRelease(handle_bb);
   IndicatorRelease(handle_atr);
   IndicatorRelease(handle_ema);
   
   // ลบป้าย Label ออกทั้งหมดเมื่อปิด EA เพื่อความสะอาดของกราฟ
   ObjectsDeleteAll(0, "UI_");
  }

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(AvelquaBotClosePoll())
      return;

   ResetDailyFlagsIfNeeded();
   
   // อัปเดตข้อมูลข่าว (ทุกๆ 4 ชั่วโมง เพื่อไม่ให้โดนแบน IP)
   FetchNews();
   
   // อัปเดต Dashboard ทุกๆ Tick เพื่อให้ตัวเลขวิ่งแบบ Real-time
   UpdateDashboard();

   if(!IsAvelquaTradingEnabled())
      return;

   if(CheckCutLoss()) return;
   if(CheckDailyProfitLoss()) return;
   
   // ถ้าใช้โควต้าคำสั่งรายวันหมดแล้ว ให้ EA หยุดทำงานไปเลย เพื่อกันโดนโบรกเกอร์แบน
   if(daily_command_count >= InpMaxDailyCommands)
   {
      LogTradeInfo("DAILY_LIMIT", POSITION_TYPE_BUY, "daily command limit reached");
      return;
   }

   ManageGrid(POSITION_TYPE_BUY);
   CheckTakeProfitAverage(POSITION_TYPE_BUY);
   CheckMoneyTrailing(POSITION_TYPE_BUY);

   ManageGrid(POSITION_TYPE_SELL);
   CheckTakeProfitAverage(POSITION_TYPE_SELL);
   CheckMoneyTrailing(POSITION_TYPE_SELL);
  }

//+------------------------------------------------------------------+
//| Timer — ตรวจ halt / bot_close.txt แม้ไม่มี tick                      |
//+------------------------------------------------------------------+
void OnTimer()
  {
   AvelquaBotClosePoll();
  }

//+------------------------------------------------------------------+
//| ฟังก์ชันสร้างและอัปเดต Dashboard (Label บนกราฟ)                        |
//+------------------------------------------------------------------+
void UpdateDashboard()
{
   double balance     = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity      = AccountInfoDouble(ACCOUNT_EQUITY);
   double free_margin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   long   leverage    = AccountInfoInteger(ACCOUNT_LEVERAGE);
   double spread      = SymbolInfoInteger(_Symbol, SYMBOL_SPREAD) * _Point;
   double profit_all  = 0;
   
   // คำนวณ Profit รวมเฉพาะของ EA ตัวนี้ (รวม Swap และ Commission)
   for(int i=0; i<PositionsTotal(); i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
      {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && PositionGetString(POSITION_SYMBOL) == _Symbol)
         {
            profit_all += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP); // removed POSITION_COMMISSION
         }
      }
   }

   // --- คำนวณค่า Drawdown รอบปัจจุบัน (Session) ---
   double current_dd = balance - equity;
   if(current_dd > max_drawdown_val && current_dd > 0) 
      max_drawdown_val = current_dd;
   
   // ถ้ายอดเงินมากกว่าหรือเท่ากับทุน (กำไร) ให้ล้างค่า MaxDD รอบปัจจุบัน
   if(equity >= balance) max_drawdown_val = 0;

   // --- คำนวณค่า Drawdown (All Time) ---
   double current_dd_money = balance - equity;
   double current_dd_pct = 0.0;
   
   if(balance > 0 && current_dd_money > 0)
   {
      current_dd_pct = (current_dd_money / balance) * 100.0;
   }
   
   // ถ้า DD ปัจจุบันทำสถิติใหม่ ให้บันทึกทับและ Save ลง Global Variable
   if(current_dd_money > all_time_max_dd_money)
   {
      all_time_max_dd_money = current_dd_money;
      GlobalVariableSet(gv_dd_money_name, all_time_max_dd_money);
   }
   
   if(current_dd_pct > all_time_max_dd_pct)
   {
      all_time_max_dd_pct = current_dd_pct;
      GlobalVariableSet(gv_dd_pct_name, all_time_max_dd_pct);
   }

   // --- เริ่มสร้างหน้าจอ (Dashboard) ---
   int x_lbl = 120; // ระยะห่างจากซ้าย สำหรับหัวข้อ
   int x_val = 20;  // ระยะห่างจากซ้าย สำหรับตัวเลข
   int y_start = 30; // จุดเริ่มต้นความสูง
   int step_y = 18;  // ระยะห่างแต่ละบรรทัด

   // บรรทัด 1: Balance
   CreateLabel("UI_Bal_Lbl", "Balance", x_lbl, y_start, clrLightGray);
   CreateLabel("UI_Bal_Val", DoubleToString(balance, 2), x_val, y_start, clrWhite);

   // บรรทัด 2: ProfitLot
   CreateLabel("UI_Prof_Lbl", "ProfitLot", x_lbl, y_start + step_y, clrLightGray);
   color profit_clr = (profit_all >= 0) ? clrLime : clrRed;
   CreateLabel("UI_Prof_Val", DoubleToString(profit_all, 2), x_val, y_start + step_y, profit_clr);

   // บรรทัด 3: Equity
   CreateLabel("UI_Eq_Lbl", "Equity", x_lbl, y_start + (step_y*2), clrLightGray);
   CreateLabel("UI_Eq_Val", DoubleToString(equity, 2), x_val, y_start + (step_y*2), clrWhite);

   // บรรทัด 4: Leverage
   CreateLabel("UI_Lev_Lbl", "Leverage", x_lbl, y_start + (step_y*3), clrLightGray);
   CreateLabel("UI_Lev_Val", IntegerToString(leverage), x_val, y_start + (step_y*3), clrWhite);

   // บรรทัด 5: FreeMargin (เน้นสีเหลืองตามรูป)
   CreateLabel("UI_FM_Lbl", "FreeMargin", x_lbl, y_start + (step_y*4), clrLightGray);
   CreateLabel("UI_FM_Val", DoubleToString(free_margin, 2), x_val, y_start + (step_y*4), clrYellow);

   // บรรทัด 6: MaxDD (รอบปัจจุบัน)
   CreateLabel("UI_DD_Lbl", "MaxDD (Session)", x_lbl, y_start + (step_y*5), clrLightGray);
   CreateLabel("UI_DD_Val", "-" + DoubleToString(max_drawdown_val, 2), x_val, y_start + (step_y*5), clrWhite); 
   
   // บรรทัด 7: All Time Max DD
   CreateLabel("UI_AllDD_Lbl", "MaxDD All Time", x_lbl, y_start + (step_y*6), clrLightGray);
   string alldd_str = "-" + DoubleToString(all_time_max_dd_money, 2) + " (" + DoubleToString(all_time_max_dd_pct, 2) + "%)";
   CreateLabel("UI_AllDD_Val", alldd_str, x_val, y_start + (step_y*6), clrRed); 

   // บรรทัด 8: Spread
   CreateLabel("UI_Spd_Lbl", "Spread", x_lbl, y_start + (step_y*7), clrLightGray);
   CreateLabel("UI_Spd_Val", DoubleToString(spread, 2), x_val, y_start + (step_y*7), clrWhite);

   // บรรทัด 9: Daily Commands (ยอดนับคำสั่งแบบ Real-time)
   CreateLabel("UI_Cmd_Lbl", "Daily Cmds", x_lbl, y_start + (step_y*8), clrLightGray);
   
   color cmd_clr = clrLightSkyBlue;
   if(daily_command_count > (InpMaxDailyCommands * 0.8)) cmd_clr = clrYellow;
   if(daily_command_count >= InpMaxDailyCommands) cmd_clr = clrRed;
   CreateLabel("UI_Cmd_Val", IntegerToString(daily_command_count) + " / " + IntegerToString(InpMaxDailyCommands), x_val, y_start + (step_y*8), cmd_clr);

   // บรรทัด 10: Weekly Commands
   CreateLabel("UI_WCmd_Lbl", "Weekly Cmds", x_lbl, y_start + (step_y*9), clrLightGray);
   CreateLabel("UI_WCmd_Val", IntegerToString(weekly_command_count), x_val, y_start + (step_y*9), clrLightSkyBlue);

   // ลายเส้นประแบ่งโซน
   CreateLabel("UI_Line", "-------------------", x_val, y_start + (step_y*10)+10, clrWhite);

   // ชื่อคู่เงินขนาดใหญ่ด้านล่าง
   CreateLabel("UI_Symbol", _Symbol, x_val, y_start + (step_y*12), clrYellow, 22);

   // --- แจ้งเตือนสถานะต่างๆ ---
   if(daily_command_count >= InpMaxDailyCommands)
   {
      CreateLabel("UI_WarnCmd", "!!! SERVER LIMIT REACHED !!!", x_val, y_start + (step_y*14), clrRed, 12);
      CreateLabel("UI_WarnCmd2", "(EA paused to protect account)", x_val, y_start + (step_y*15), clrLightGray, 10);
   }
   else if(InpSoftClose)
   {
      CreateLabel("UI_SoftClose", "!!! SOFT CLOSE ACTIVE !!!", x_val, y_start + (step_y*14), clrMagenta, 12);
      CreateLabel("UI_SoftClose2", "(Waiting to clear all orders)", x_val, y_start + (step_y*15), clrLightGray, 10);
   }
   else if(is_news_pausing)
   {
      CreateLabel("UI_NewsPause", "!!! PAUSED BY NEWS FILTER !!!", x_val, y_start + (step_y*14), clrOrange, 12);
      CreateLabel("UI_NewsPause2", "(Waiting for safe time to trade)", x_val, y_start + (step_y*15), clrLightGray, 10);
   }
   else
   {
      ObjectDelete(0, "UI_WarnCmd");
      ObjectDelete(0, "UI_WarnCmd2");
      ObjectDelete(0, "UI_SoftClose");
      ObjectDelete(0, "UI_SoftClose2");
      ObjectDelete(0, "UI_NewsPause");
      ObjectDelete(0, "UI_NewsPause2");
   }
}

// Helper Function สำหรับสร้าง Object Text บนกราฟ
void CreateLabel(string name, string text, int x, int y, color clr, int size=10)
{
   if(ObjectFind(0, name) < 0) 
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, size);
   ObjectSetString(0, name, OBJPROP_FONT, "Arial Bold"); // ใช้ฟอนต์หนาให้อ่านง่าย
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER); // ยึดมุมซ้ายบน
}

void LogTradeFailure(string tag, ENUM_POSITION_TYPE type, double lot, double price)
{
   Print(
      "ORDER FAIL [", tag, "] ",
      EnumToString(type),
      " lot=", DoubleToString(lot, 2),
      " price=", DoubleToString(price, _Digits),
      " retcode=", IntegerToString((int)trade.ResultRetcode()),
      " desc=", trade.ResultRetcodeDescription(),
      " lasterr=", IntegerToString(GetLastError())
   );
}

void LogTradeInfo(string tag, ENUM_POSITION_TYPE type, string message)
{
   datetime now = TimeCurrent();
   if(now - last_diag_log_time < 60)
      return;
   last_diag_log_time = now;
   Print("TRADE INFO [", tag, "] ", EnumToString(type), " ", message);
}

//+------------------------------------------------------------------+
//| ฟังก์ชันตรวจสอบ Sideway (อนุญาตให้ออกไม้แรก)                          |
//+------------------------------------------------------------------+
bool IsSidewayCondition()
  {
   if(!InpUseTrendFilter) return true;

   if(InpUseADXFilter)
     {
      double adx[1];
      if(CopyBuffer(handle_adx, 0, 0, 1, adx) > 0)
        {
         if(adx[0] >= InpAdxThreshold) return false;
        }
     }
   
   if(InpUseBBFilter)
     {
      double bb_up[1], bb_dn[1], atr[1];
      if(CopyBuffer(handle_bb, 1, 0, 1, bb_up) > 0 && 
         CopyBuffer(handle_bb, 2, 0, 1, bb_dn) > 0 && 
         CopyBuffer(handle_atr, 0, 0, 1, atr) > 0)
        {
         double bb_width = bb_up[0] - bb_dn[0];
         if(bb_width > (atr[0] * InpBbAtrMultiplier)) return false;
        }
     }
   
   if(InpUseEMAFilter)
     {
      double ema[4];
      if(CopyBuffer(handle_ema, 0, 0, 4, ema) > 0)
        {
         if(MathAbs(ema[3] - ema[0]) / _Point > InpEmaFlatPoints) return false;
        }
     }

   return true;
  }

//+------------------------------------------------------------------+
//| ฟังก์ชันตรวจสอบเทรนด์รุนแรง (ระงับการออก Grid)                         |
//+------------------------------------------------------------------+
bool IsTrendTooStrongToGrid()
  {
   if(PositionsTotal() == 0) return false;

   double current_ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double current_bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   bool is_trend_strong = false;

   if(InpUseADXFilter)
     {
      double adx[1];
      if(CopyBuffer(handle_adx, 0, 0, 1, adx) > 0)
        {
         if(adx[0] > (InpAdxThreshold + 10.0)) is_trend_strong = true;
        }
     }
   
   double high_arr[], low_arr[];
   if(CopyHigh(_Symbol, PERIOD_CURRENT, 1, InpBreakoutBars, high_arr) > 0 && 
      CopyLow(_Symbol, PERIOD_CURRENT, 1, InpBreakoutBars, low_arr) > 0)
     {
      double highest_high = high_arr[ArrayMaximum(high_arr)];
      double lowest_low   = low_arr[ArrayMinimum(low_arr)];
      
      if(current_bid > highest_high || current_ask < lowest_low) is_trend_strong = true;
     }

   if(is_trend_strong)
     {
      return true;
     }

   return false;
  }

//+------------------------------------------------------------------+
//| ฟังก์ชันจัดการออกไม้ Grid (บังคับดูแลไม้เก่าให้จบก่อน)                      |
//+------------------------------------------------------------------+
void ManageGrid(ENUM_POSITION_TYPE type)
  {
   // [ด่านที่ 1] ป้องกันการออกไม้ซ้ำภายใน 2 วินาที
   if(TimeCurrent() - last_trade_time < 2) return;

   int count = 0;
   double last_price = 0.0;
   double max_lot = 0.0;

   // ใช้การสแกนด้วย PositionGetTicket เพื่อความเสถียร ไม่ทิ้งไม้เก่า
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && 
            PositionGetInteger(POSITION_TYPE) == type && 
            PositionGetString(POSITION_SYMBOL) == _Symbol)
           {
            count++;
            double p_price = PositionGetDouble(POSITION_PRICE_OPEN);
            double p_lot = PositionGetDouble(POSITION_VOLUME);
            
            if(max_lot == 0.0 || p_lot > max_lot) max_lot = p_lot;

            if(type == POSITION_TYPE_BUY)
              {
               if(last_price == 0.0 || p_price < last_price) last_price = p_price;
              }
            else
              {
               if(last_price == 0.0 || p_price > last_price) last_price = p_price;
              }
           }
        }
     }

   double current_ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double current_bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // ถ้า "ไม่มี" ไม้ค้างอยู่เลย ถึงจะยอมให้เปิด Initial Trade ได้ (เริ่มชุดใหม่)
   if(count == 0)
     {
      if(InpSoftClose)
      {
         LogTradeInfo("SKIP", type, "soft close active");
         return;
      }

      if(InpUseTimeFilter && !IsAnySessionActive())
      {
         LogTradeInfo("SKIP", type, "outside active session");
         return;
      }
      if(!IsSidewayCondition())
      {
         LogTradeInfo("SKIP", type, "sideway condition rejected");
         return;
      }
      
      // --- ระบบ News Filter ป้องกันการเปิดไม้แรก ---
      if(InpUseNewsFilter && IsNewsRestricted())
        {
         is_news_pausing = true;
         LogTradeInfo("SKIP", type, "news filter paused first entry");
         return; // สั่งหยุด ไม่ให้เปิดไม้แรก
        }
      else
        {
         is_news_pausing = false; // ถ้าไม่มีข่าว ให้เทรดปกติ
        }
      // ------------------------------------------

      bool is_success = false;
      
      daily_command_count++; 
      weekly_command_count++; 
      
      // เมื่อเปิดชุดใหม่ ใช้ค่า InpLotSize ตามที่คุณเพิ่งตั้งใน Input
      LogTradeInfo("INITIAL_ATTEMPT", type, "trying first order");
      ResetLastError();
      if(type == POSITION_TYPE_BUY) is_success = trade.Buy(InpLotSize, _Symbol, current_ask, 0, 0, "Initial Buy");
      else is_success = trade.Sell(InpLotSize, _Symbol, current_bid, 0, 0, "Initial Sell");
      
      if(is_success) 
      {
         last_trade_time = TimeCurrent();
         Print("ORDER OK [INITIAL] ", EnumToString(type), " order=", IntegerToString((int)trade.ResultOrder()));
      }
      else
      {
         LogTradeFailure("INITIAL", type, InpLotSize, (type == POSITION_TYPE_BUY ? current_ask : current_bid));
      }

      // รีเซ็ตค่า Trailing เมื่อชุดก่อนหน้าปิดจบหมดจริงๆ
      if(type == POSITION_TYPE_BUY) highest_profit_buy = 0.0;
      else highest_profit_sell = 0.0;
     }
   // ถ้า "มี" ไม้ค้างอยู่ (ชุดเก่า) -> บังคับให้ดูแลชุดเก่าต่อให้จบ ไม่อนุญาตให้เริ่มไม้ 1 ซ้อน
   else
     {
      if(InpUseTrendFilter && IsTrendTooStrongToGrid())
      {
         LogTradeInfo("SKIP_GRID", type, "trend too strong");
         return;
      }

      // คำนวณ Lot ไม้ต่อไป โดยดูจาก Max Lot ของไม้ที่ค้างอยู่จริงในตลาด บวกด้วย InpLotPlus
      double next_lot = NormalizeDouble(max_lot + InpLotPlus, 2);

      if(type == POSITION_TYPE_BUY && current_ask <= last_price - (InpPipStep * _Point))
        {
         daily_command_count++; 
         weekly_command_count++; 
         
         ResetLastError();
         if(trade.Buy(next_lot, _Symbol, current_ask, 0, 0, "Grid Buy " + (string)count))
         {
            last_trade_time = TimeCurrent();
            Print("ORDER OK [GRID] ", EnumToString(type), " order=", IntegerToString((int)trade.ResultOrder()));
         }
         else
         {
            LogTradeFailure("GRID", type, next_lot, current_ask);
         }
        }
      else if(type == POSITION_TYPE_SELL && current_bid >= last_price + (InpPipStep * _Point))
        {
         daily_command_count++; 
         weekly_command_count++; 
         
         ResetLastError();
         if(trade.Sell(next_lot, _Symbol, current_bid, 0, 0, "Grid Sell " + (string)count))
         {
            last_trade_time = TimeCurrent();
            Print("ORDER OK [GRID] ", EnumToString(type), " order=", IntegerToString((int)trade.ResultOrder()));
         }
         else
         {
            LogTradeFailure("GRID", type, next_lot, current_bid);
         }
        }
     }
  }

//+------------------------------------------------------------------+
//| ฟังก์ชันตรวจสอบเวลา 3 Sessions                                     |
//+------------------------------------------------------------------+
bool IsAnySessionActive()
  {
   if(!InpUseSession1 && !InpUseSession2 && !InpUseSession3) return false;

   datetime curr_gmt = TimeGMT();
   datetime thai_time = curr_gmt + (7 * 3600); // UTC+7
   
   MqlDateTime curr_time;
   TimeToStruct(thai_time, curr_time);
   int curr_mins = (curr_time.hour * 60) + curr_time.min;
   
   bool is_active = false;

   if(InpUseSession1 && IsTimeInWindow(curr_mins, InpStartTime1, InpStopTime1)) is_active = true;
   if(InpUseSession2 && IsTimeInWindow(curr_mins, InpStartTime2, InpStopTime2)) is_active = true;
   if(InpUseSession3 && IsTimeInWindow(curr_mins, InpStartTime3, InpStopTime3)) is_active = true;

   return is_active;
  }

bool IsTimeInWindow(int curr_mins, string start_str, string stop_str)
  {
   string start_parts[];
   StringSplit(start_str, ':', start_parts);
   int start_mins = (int)(StringToInteger(start_parts[0]) * 60) + (int)StringToInteger(start_parts[1]);
   
   string stop_parts[];
   StringSplit(stop_str, ':', stop_parts);
   int stop_mins = (int)(StringToInteger(stop_parts[0]) * 60) + (int)StringToInteger(stop_parts[1]);

   if(start_mins < stop_mins) return (curr_mins >= start_mins && curr_mins <= stop_mins);
   else return (curr_mins >= start_mins || curr_mins <= stop_mins);
  }

//+------------------------------------------------------------------+
//| Utilities Functions                                              |
//+------------------------------------------------------------------+
void CheckTakeProfitAverage(ENUM_POSITION_TYPE type)
  {
   double total_vol = 0.0;
   double weighted_price = 0.0;
   int count = 0;

   // สแกนไม้ทั้งหมดในตะกร้าชุดปัจจุบันอย่างละเอียด
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && 
            PositionGetInteger(POSITION_TYPE) == type && 
            PositionGetString(POSITION_SYMBOL) == _Symbol)
           {
            double p_lot = PositionGetDouble(POSITION_VOLUME);
            double p_price = PositionGetDouble(POSITION_PRICE_OPEN);
            weighted_price += (p_price * p_lot);
            total_vol += p_lot;
            count++;
           }
        }
     }

   if(count == 0) return;

   double avg_price = weighted_price / total_vol;
   double current_price = (type == POSITION_TYPE_BUY) ? SymbolInfoDouble(_Symbol, SYMBOL_BID) : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   bool should_close = false;

   // ใช้ InpTakeProfitAverage ล่าสุดในการคำนวณจุดปิดกำไร
   if(type == POSITION_TYPE_BUY && current_price >= avg_price + (InpTakeProfitAverage * _Point)) should_close = true;
   if(type == POSITION_TYPE_SELL && current_price <= avg_price - (InpTakeProfitAverage * _Point)) should_close = true;

   if(should_close)
     {
      CloseBasket(type);
      Print("TP Average Reached for ", EnumToString(type), " (Basket of ", count, " orders closed)");
     }
  }

void CheckMoneyTrailing(ENUM_POSITION_TYPE type)
  {
   if(InpTrailingStartMoney <= 0) return;

   double total_profit = 0.0;
   int count = 0;

   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && 
            PositionGetInteger(POSITION_TYPE) == type && 
            PositionGetString(POSITION_SYMBOL) == _Symbol)
           {
            total_profit += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP); // removed POSITION_COMMISSION
            count++;
           }
        }
     }

   if(count == 0) return;

   if(type == POSITION_TYPE_BUY)
     {
      if(total_profit > highest_profit_buy) highest_profit_buy = total_profit;
      if(highest_profit_buy >= InpTrailingStartMoney && total_profit <= (highest_profit_buy - InpTrailingStopMoney))
        {
         CloseBasket(type);
         Print("Money Trailing Hit for BUY. Highest: ", highest_profit_buy);
         highest_profit_buy = 0.0;
        }
     }
   else
     {
      if(total_profit > highest_profit_sell) highest_profit_sell = total_profit;
      if(highest_profit_sell >= InpTrailingStartMoney && total_profit <= (highest_profit_sell - InpTrailingStopMoney))
        {
         CloseBasket(type);
         Print("Money Trailing Hit for SELL. Highest: ", highest_profit_sell);
         highest_profit_sell = 0.0;
        }
     }
  }

bool CheckCutLoss()
  {
   if(InpCutLossPct >= 100.0) return false;
   
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double dd_percent = (1.0 - (equity / balance)) * 100.0;
   
   if(dd_percent >= InpCutLossPct)
     {
      CloseBasket(POSITION_TYPE_BUY);
      CloseBasket(POSITION_TYPE_SELL);
      Print("!!! CUT LOSS TRIGGERED AT ", DoubleToString(dd_percent, 2), "% !!!");
      return true;
     }
   return false;
  }

void CloseBasket(ENUM_POSITION_TYPE type)
  {
   // วนลูปปิดทีละไม้จนกว่าจะหมดตะกร้า
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && 
            PositionGetInteger(POSITION_TYPE) == type && 
            PositionGetString(POSITION_SYMBOL) == _Symbol)
           {
            daily_command_count++;
            weekly_command_count++; 
            trade.PositionClose(ticket);
           }
        }
     }
  }

void ResetDailyFlagsIfNeeded()
  {
   datetime gmt = TimeGMT();
   datetime thai_time = gmt + (7 * 3600);
   MqlDateTime dt;
   TimeToStruct(thai_time, dt);
   
   // --- เช็ควันใหม่ ---
   if(dt.day_of_year != last_thai_day)
     {
      last_thai_day = dt.day_of_year;
      daily_limit_hit = false;
      
      daily_command_count = 0; 
      
      Print("--- ขึ้นวันใหม่ (เวลาไทย) เคลียร์ยอด Daily Commands ---");
     }

   // --- เช็คสัปดาห์ใหม่ (เริ่มวันจันทร์) ---
   if(dt.day_of_week == 1 && last_thai_week != 1) 
     {
      weekly_command_count = 0;
      Print("--- ขึ้นสัปดาห์ใหม่ (วันจันทร์) เคลียร์ยอด Weekly Commands ---");
     }
     
   last_thai_week = dt.day_of_week; 
  }

bool CheckDailyProfitLoss()
  {
   if(InpDailyProfitTarget <= 0 && InpDailyLossLimit <= 0) return false;
   if(daily_limit_hit) return true;

   datetime gmt = TimeGMT();
   datetime thai_time = gmt + (7 * 3600);
   MqlDateTime dt; 
   TimeToStruct(thai_time, dt);
   
   int seconds_since_thai_midnight = (dt.hour * 3600) + (dt.min * 60) + dt.sec;
   datetime server_time = TimeCurrent();
   datetime start_of_thai_day_server = server_time - seconds_since_thai_midnight;

   HistorySelect(start_of_thai_day_server, server_time + 86400);
   double daily_realized = 0.0;
   
   for(int i = 0; i < HistoryDealsTotal(); i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket > 0)
        {
         if(HistoryDealGetInteger(ticket, DEAL_MAGIC) == InpMagicNumber && 
            HistoryDealGetString(ticket, DEAL_SYMBOL) == _Symbol)
           {
            daily_realized += HistoryDealGetDouble(ticket, DEAL_PROFIT) + 
                              HistoryDealGetDouble(ticket, DEAL_SWAP) + 
                              HistoryDealGetDouble(ticket, DEAL_COMMISSION);
           }
        }
     }

   double floating_profit = 0.0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(PositionSelectByTicket(ticket))
        {
         if(PositionGetInteger(POSITION_MAGIC) == InpMagicNumber && 
            PositionGetString(POSITION_SYMBOL) == _Symbol)
           {
            floating_profit += PositionGetDouble(POSITION_PROFIT) + 
                               PositionGetDouble(POSITION_SWAP); // removed POSITION_COMMISSION
           }
        }
     }

   double total_daily_pnl = daily_realized + floating_profit;

   if(InpDailyProfitTarget > 0 && total_daily_pnl >= InpDailyProfitTarget)
     {
      CloseBasket(POSITION_TYPE_BUY);
      CloseBasket(POSITION_TYPE_SELL);
      daily_limit_hit = true;
      Print("!!! Daily Profit Target Reached !!!");
      return true;
     }

   if(InpDailyLossLimit > 0 && total_daily_pnl <= -InpDailyLossLimit)
     {
      CloseBasket(POSITION_TYPE_BUY);
      CloseBasket(POSITION_TYPE_SELL);
      daily_limit_hit = true;
      Print("!!! Daily Loss Limit Reached !!!");
      return true;
     }

   return false;
  }

//+------------------------------------------------------------------+
//| News Filter Functions (ดึงข่าวและเช็คเงื่อนไข)                          |
//+------------------------------------------------------------------+
string ExtractJSONValue(string json, string key)
{
   string search = "\"" + key + "\":\"";
   int start = StringFind(json, search);
   if(start < 0) return "";
   start += StringLen(search);
   int end = StringFind(json, "\"", start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
}

void ParseFFNews(string json)
{
   ArrayResize(NewsData, 0);
   int json_pos = 0; // แก้ไขชื่อตัวแปรตรงนี้เพื่อหลบ Warning
   while((json_pos = StringFind(json, "{", json_pos)) >= 0)
   {
      int end_pos = StringFind(json, "}", json_pos);
      if(end_pos < 0) break;
      string obj = StringSubstr(json, json_pos, end_pos - json_pos + 1);

      string country = ExtractJSONValue(obj, "country");
      string impact = ExtractJSONValue(obj, "impact");
      string date_str = ExtractJSONValue(obj, "date"); // format: "2023-08-15T08:30:00-04:00"

      if(country != "" && impact != "" && date_str != "")
      {
         string y = StringSubstr(date_str, 0, 4);
         string m = StringSubstr(date_str, 5, 2);
         string d = StringSubstr(date_str, 8, 2);
         string h = StringSubstr(date_str, 11, 2);
         string min = StringSubstr(date_str, 14, 2);
         string sec = StringSubstr(date_str, 17, 2);

         string sign = StringSubstr(date_str, 19, 1);
         int off_h = (int)StringToInteger(StringSubstr(date_str, 20, 2));
         if(sign == "-") off_h = -off_h;

         MqlDateTime dt;
         dt.year = (int)StringToInteger(y);
         dt.mon = (int)StringToInteger(m);
         dt.day = (int)StringToInteger(d);
         dt.hour = (int)StringToInteger(h);
         dt.min = (int)StringToInteger(min);
         dt.sec = (int)StringToInteger(sec);

         datetime local_time = StructToTime(dt); // เวลาฝั่งอเมริกา
         datetime utc_time = local_time - (off_h * 3600); // แปลงเป็น UTC
         datetime broker_time = utc_time + (InpBrokerGMT * 3600); // แปลงเป็นเวลาเซิร์ฟเวอร์โบรกเกอร์

         int size = ArraySize(NewsData);
         ArrayResize(NewsData, size + 1);
         NewsData[size].country = country;
         NewsData[size].impact = impact;
         NewsData[size].broker_time = broker_time;
      }
      json_pos = end_pos + 1; // อัปเดตตำแหน่งใหม่
   }
}

void FetchNews()
{
   if(!InpUseNewsFilter) return;
   
   // ดึงข่าวทุกๆ 4 ชั่วโมงเพื่อป้องกันการโดนแบนจากเว็บ Forex Factory
   if(TimeCurrent() - last_news_fetch < 14400) return; 

   string url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
   string cookie = NULL, headers = "";
   char post[], result[];
   
   // จำเป็นต้องเปิด Allow WebRequest ใน MT5 (Tools -> Options -> Expert Advisors)
   int res = WebRequest("GET", url, cookie, NULL, 5000, post, 0, result, headers);

   if(res == 200)
   {
      string json = CharArrayToString(result);
      ParseFFNews(json);
      last_news_fetch = TimeCurrent();
      Print("✅ News Filter: โหลดข้อมูลข่าวสัปดาห์นี้เรียบร้อย (พบ ", ArraySize(NewsData), " ข่าว)");
   }
   else
   {
      Print("❌ News Filter Error: โหลดข่าวไม่ได้รหัส ", res, " (เช็ค Allow WebRequest ด้วยนะครับ)");
      last_news_fetch = TimeCurrent() - 14100; // ถ้าพังให้รอ 5 นาทีค่อยดึงใหม่
   }
}

bool IsNewsRestricted()
{
   if(!InpUseNewsFilter) return false;
   if(ArraySize(NewsData) == 0) return false;

   datetime current_time = TimeCurrent();
   string current_symbol = _Symbol; 

   // ดึงสกุลเงิน 3 ตัวหน้า และ 3 ตัวหลัง เช่น EURUSD -> EUR, USD
   string base_curr = StringSubstr(current_symbol, 0, 3);
   string quote_curr = StringSubstr(current_symbol, 3, 3);

   for(int i=0; i<ArraySize(NewsData); i++)
   {
      bool impact_match = false;
      int mins_before = 0;
      int mins_after = 0;

      if(InpAvoidRed && NewsData[i].impact == "High")
      {
         impact_match = true;
         mins_before = InpRedMinsBefore;
         mins_after = InpRedMinsAfter;
      }
      else if(InpAvoidOrange && NewsData[i].impact == "Medium")
      {
         impact_match = true;
         mins_before = InpOrangeMinsBefore;
         mins_after = InpOrangeMinsAfter;
      }

      if(!impact_match) continue;

      // ตรวจสอบว่าข่าวตรงกับสกุลเงินที่เราเทรดอยู่หรือไม่
      bool curr_match = false;
      if(InpNewsCurrency == "ALL") 
      {
         curr_match = true; // หยุดเทรดทุกสกุลเงินถ้ามีข่าวแรง
      }
      else 
      {
         // Forex Factory แจ้งประเทศ/สกุลเงินในช่อง country เช่น USD, EUR
         if(NewsData[i].country == base_curr || NewsData[i].country == quote_curr) curr_match = true;
      }

      if(!curr_match) continue;

      datetime news_time = NewsData[i].broker_time;
      datetime start_pause = news_time - (mins_before * 60);
      datetime end_pause = news_time + (mins_after * 60);

      // ถ้าเวลาปัจจุบันอยู่ในช่วงที่ต้องหยุดพัก (ก่อนข่าว ถึง หลังข่าว)
      if(current_time >= start_pause && current_time <= end_pause)
      {
         return true; // สั่งห้ามเทรดไม้แรก
      }
   }
   
   return false; // เทรดได้ปกติ
}
//+------------------------------------------------------------------+