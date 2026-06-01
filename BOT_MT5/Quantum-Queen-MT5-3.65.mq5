#property strict
#property copyright   "Copyright, PA-SNIPER Tel 096-0946546"
#property link        "PHATCHON"
#property version     "3.65" // ปรับเวอร์ชันขึ้นเล็กน้อยครับ
#property description "This product is Exclusively available on MQL.com. Sale outside of MQL5.com are Prohibited and may result in legal action Create by PA-SNIPER"
#include <Trade\Trade.mqh>
CTrade trade;

enum ENUM_MARTINGALE_MODE
{
   MODE_MULTIPLIER = 0,
   MODE_DOUBLE     = 1, 
   MODE_CUSTOM_STEP= 2  
};

//--- อ็อปชันสำหรับเลือกโหมดคำนวณล็อต
enum ENUM_LOT_MODE
{
   LOT_FIXED       = 0,
   LOT_PER_BALANCE = 1, 
   LOT_RISK_PERC   = 2  
};

//--- อ็อปชันสำหรับเลือกโหมดคัตลอส
enum ENUM_CUTLOSS_MODE
{
   CUT_NONE        = 0, 
   CUT_PERCENT     = 1, 
   CUT_MONEY       = 2  
};

//--- คอนฟิกูเรชันจากผู้ใช้
input group "--- Panic 5-Min (Counter-Trend) ---"
input int    CrashPoints   = 2000;   // ค่าเริ่มต้นปกติเมื่อกราฟแรงหรือเปิดไม้แก้

input group "--- Lot Sizing & Auto Lot Settings ---"
input ENUM_LOT_MODE LotType = LOT_PER_BALANCE; 
input double BaseLot       = 0.01;   
input double LotPerCapital = 0.01;   
input double CapitalAmount = 2000.0; 
input double RiskPercent   = 1.0;   

input group "--- Dynamic Grid Settings (ATR) ---"
input bool    UseATRGrid    = true;  
input int     ATR_Period    = 14;     
input double ATR_Multiplier= 1.5;   
input int     MinGridSpace  = 700;   
input int     FixDistance   = 1000;   

input group "--- Martingale Settings ---"
input ENUM_MARTINGALE_MODE MartiMode = MODE_MULTIPLIER; 
input double LotMultiplier = 1;   
input double CustomStep1_3 = 1.3;   
input double CustomStep4_Up= 1.5;   

input group "--- Safety & Absolute Cut Loss ---"
input ENUM_CUTLOSS_MODE CutMode = CUT_NONE; 
input double MaxDrawdownPercent = 30.0;        
input double MaxLossAmount      = 3000.0;       
input bool    AntiCluster       = true;   
input int    MaxSpread         = 50;   
input int    Slippage          = 30;   
input double MaxLot            = 10.00;   
input int    MaxOpenPositions = 50;   
input int    TargetTP          = 200;   
input ulong  MagicNumber       = 888777; 

 //group "--- Trailing Stop Settings ---"
 bool    UseTrailing   = true;   
 int     TrailingStart = 150;   
 int     TrailingStop  = 100;     
 int     TrailingStep  = 20;    

//--- ตัวแปรสำหรับระบบภายใน
datetime last_trade_bar = 0; 
datetime last_grid_bar  = 0; 
int      atr_handle;         

//--- ระบบสลับ CrashPoints อัตโนมัติ (Dynamic CrashPoints)
int      CurrentCrashPoints = 2000; 

//--- ตัวแปรสำหรับสถิติแดชบอร์ด
string   panel_name = "Quantum Queen";
double   global_break_even = 0.0;
double   global_target_tp  = 0.0;

//--- Protection
string ExpirationDate = "2028.6.15";
long   AllowedAccount = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   if(TimeCurrent() > StringToTime(ExpirationDate)) { Print("❌ EA Expired"); return(INIT_FAILED); }
   if(AllowedAccount != 0 && AccountInfoInteger(ACCOUNT_LOGIN) != AllowedAccount) { Print("❌ Wrong Account"); return(INIT_FAILED); }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(Slippage);
   
   atr_handle = iATR(_Symbol, PERIOD_M15, ATR_Period);
   if(atr_handle == INVALID_HANDLE)
   {
      Print("ไม่สามารถสร้าง Handle ของ ATR อินดิเคเตอร์ได้!");
      return(INIT_FAILED);
   }
   
   // กำหนดค่าตั้งต้นตามหน้า Input ผู้ใช้
   CurrentCrashPoints = CrashPoints;

   CreateDashboardBackground();
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   IndicatorRelease(atr_handle);
   ObjectsDeleteAll(0, panel_name);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick()
{
   MqlTick last_tick;
   if(!SymbolInfoTick(_Symbol, last_tick)) return;

   if(CheckAndExecuteCutLoss())
   {
      return;
   }

   int current_spread = (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   
   bool has_buy = false;
   bool has_sell = false;
   int total_positions = CheckExistingPositions(has_buy, has_sell);

   double m5_open_price = GetM5OpenPrice();
   double current_m5_distance = 0.0;
   if(m5_open_price > 0)
   {
      current_m5_distance = MathAbs(last_tick.bid - m5_open_price) / _Point;
   }

   //--- [ระบบคัดกรองความแรงของกราฟเพื่อสลับ CrashPoints อัตโนมัติ] ---
   if(total_positions == 0)
   {
      // ถ้านิ่งๆ ไม่มีออเดอร์ค้าง และวิ่งช้าในแท่ง ให้ปรับมาเป็น 1000 เพื่อเน้นออกออเดอร์ง่ายขึ้น
      if(current_m5_distance < 1000)
      {
         CurrentCrashPoints = 1000;
      }
      // หากกราฟวิ่งแรงจัด ทะลุ 1000 ไปอย่างรวดเร็วในแท่งเดียว ให้ดีดกลับไปเซฟตี้ที่ 2000 อัตโนมัติ
      else if(current_m5_distance >= 1000 && CurrentCrashPoints == 1000)
      {
         CurrentCrashPoints = 2000;
         Print("⚡ กราฟเริ่มแรง! สลับ CrashPoints ไปที่ 2000 อัตโนมัติ เพื่อความปลอดภัย");
      }
   }
   else
   {
      // ถ้าเริ่มมีการลากหรือติดไม้แก้ (ค้างสภาวะติดลบ) บังคับใช้ระยะปลอดภัยสูงสุด (2000) ทันที
      CurrentCrashPoints = (CrashPoints > 2000) ? CrashPoints : 2000;
   }

   // ส่งค่า CurrentCrashPoints ไปอัปเดตบนหน้าจอแทนค่าฟิกซ์เดิม
   UpdateDashboardLabels(current_spread, total_positions, has_buy, has_sell, current_m5_distance, last_tick);

   if(current_spread > MaxSpread) return; 

   if(total_positions == 0)
   {
      if(m5_open_price == 0) return;
      datetime m5_bar_time = iTime(_Symbol, PERIOD_M5, 0);

      double price_diff_up    = last_tick.ask - m5_open_price; 
      double price_diff_down  = m5_open_price - last_tick.bid; 
      
      // ใช้ค่า CurrentCrashPoints ที่ถูกคำนวณแบบ Dynamic ในการยิงออเดอร์แรก
      double trigger_distance = CurrentCrashPoints * _Point;

      if(m5_bar_time != last_trade_bar)
      {
         double dynamic_initial_lot = CalculateAutoLot();

         if(price_diff_up >= trigger_distance)
         {
            if(trade.Sell(dynamic_initial_lot, _Symbol, last_tick.bid, 0, 0, "Counter Sell Initial"))
               last_trade_bar = m5_bar_time; 
         }
         else if(price_diff_down >= trigger_distance)
         {
            if(trade.Buy(dynamic_initial_lot, _Symbol, last_tick.ask, 0, 0, "Counter Buy Initial"))
               last_trade_bar = m5_bar_time; 
         }
      }
      global_break_even = 0.0;
      global_target_tp = 0.0;
   }
   else
   {
      if(has_buy)
      {
         ManageGrid(POSITION_TYPE_BUY, last_tick.ask);
         UpdateAverageTP(POSITION_TYPE_BUY);
         if(UseTrailing) ApplyTrailingStop(POSITION_TYPE_BUY, last_tick.bid);
      }
      if(has_sell)
      {
         ManageGrid(POSITION_TYPE_SELL, last_tick.bid);
         UpdateAverageTP(POSITION_TYPE_SELL);
         if(UseTrailing) ApplyTrailingStop(POSITION_TYPE_SELL, last_tick.ask);
      }
   }
}

//+------------------------------------------------------------------+
//| ฟังก์ชันตรวจสอบและสั่งสับสวิตช์ Cut Loss ล้างพอร์ตเมื่อขาดทุนวิกฤต |
//+------------------------------------------------------------------+
bool CheckAndExecuteCutLoss()
{
   if(CutMode == CUT_NONE) return false;

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double total_floating_profit = 0.0;
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         total_floating_profit += PositionGetDouble(POSITION_PROFIT);
         count++;
      }
   }

   if(count == 0) return false;

   bool trigger_cut = false;

   if(CutMode == CUT_PERCENT)
   {
      double current_drawdown_percent = (MathAbs(total_floating_profit) / balance) * 100.0;
      if(total_floating_profit < 0 && current_drawdown_percent >= MaxDrawdownPercent)
      {
         Print("🚨 โดนตัดขาดทุนอัติโนมัติ! Drawdown ทะลุลิมิต: ", DoubleToString(current_drawdown_percent, 2), "%");
         trigger_cut = true;
      }
   }
   else if(CutMode == CUT_MONEY)
   {
      if(total_floating_profit < 0 && MathAbs(total_floating_profit) >= MaxLossAmount)
      {
         Print("🚨 โดนตัดขาดทุนอัติโนมัติ! ยอดลบสุทธิเกินจำนวนเงิน: ", DoubleToString(MathAbs(total_floating_profit), 2));
         trigger_cut = true;
      }
   }

   if(trigger_cut)
   {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
         {
            ulong ticket = PositionGetTicket(i);
            trade.PositionClose(ticket);
         }
      }
      global_break_even = 0.0;
      global_target_tp = 0.0;
      return true;
   }

   return false;
}

//+------------------------------------------------------------------+
//| ฟังก์ชันสร้างพื้นหลังของระบบแดชบอร์ด                             |
//+------------------------------------------------------------------+
void CreateDashboardBackground()
{
   string bg_name = panel_name + "_BG";
   ObjectCreate(0, bg_name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
   ObjectSetInteger(0, bg_name, OBJPROP_XDISTANCE, 20);     
   ObjectSetInteger(0, bg_name, OBJPROP_YDISTANCE, 40);     
   ObjectSetInteger(0, bg_name, OBJPROP_XSIZE, 290);        
   ObjectSetInteger(0, bg_name, OBJPROP_YSIZE, 380);        
   ObjectSetInteger(0, bg_name, OBJPROP_BGCOLOR, C'25,25,25'); 
   ObjectSetInteger(0, bg_name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
   ObjectSetInteger(0, bg_name, OBJPROP_COLOR, C'70,70,70');  
   
   CreateLabel(panel_name+"_Title", "Quantum Queen MT5", 30, 50, 11, C'255,165,0', true);
   
   int start_y = 75;
   int step_y  = 19;
   for(int i=1; i<=15; i++)
   {
      CreateLabel(panel_name+"_L"+(string)i, "", 30, start_y + (i*step_y), 9, C'220,220,220', false);
   }
}

//+------------------------------------------------------------------+
//| ฟังก์ชันเสริมสำหรับวาดตัวอักษรลงบนกราฟ                               |
//+------------------------------------------------------------------+
void CreateLabel(string name, string text, int x, int y, int size, color font_color, bool is_bold)
{
   ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetString(0, name, OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_COLOR, font_color);
   ObjectSetString(0, name, OBJPROP_FONT, is_bold ? "Arial Bold" : "Arial");
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, size);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
}

//+------------------------------------------------------------------+
//| ฟังก์ชันคำนวณกำไรย้อนหลังแยกตามช่วงเวลา (วัน/เดือน/ปี)              |
//+------------------------------------------------------------------+
void CalculatePeriodicProfit(double &day_profit, double &month_profit, double &year_profit)
{
   day_profit = 0; month_profit = 0; year_profit = 0;
   
   if(HistorySelect(0, TimeCurrent()))
   {
      int total_deals = HistoryDealsTotal();
      MqlDateTime now_struct, deal_struct;
      TimeToStruct(TimeCurrent(), now_struct);
      
      for(int i = 0; i < total_deals; i++)
      {
         ulong ticket = HistoryDealGetTicket(i);
         if(ticket > 0)
         {
            if(HistoryDealGetInteger(ticket, DEAL_MAGIC) == MagicNumber)
            {
               double profit = HistoryDealGetDouble(ticket, DEAL_PROFIT);
               double swap   = HistoryDealGetDouble(ticket, DEAL_SWAP);
               double comm   = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
               double net_profit = profit + swap + comm;
               
               datetime deal_time = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
               TimeToStruct(deal_time, deal_struct);
               
               if(deal_struct.year == now_struct.year)
               {
                  year_profit += net_profit;
                  if(deal_struct.mon == now_struct.mon)
                  {
                     month_profit += net_profit;
                     if(deal_struct.day == now_struct.day)
                     {
                        day_profit += net_profit;
                     }
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| ฟังก์ชันอัปเดตข้อมูลตัวอักษรบนแดชบอร์ด                             |
//+------------------------------------------------------------------+
void UpdateDashboardLabels(int spread, int total_pos, bool b_buy, bool b_sell, double m5_dist, MqlTick &tick)
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   
   double total_open_lots = 0.0;
   double floating_money = 0.0;
   
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         total_open_lots += PositionGetDouble(POSITION_VOLUME);
         floating_money += PositionGetDouble(POSITION_PROFIT);
      }
   }

   double p_day=0, p_month=0, p_year=0;
   CalculatePeriodicProfit(p_day, p_month, p_year);

   double current_step_pts = CalculateGridStep() / _Point;

   string status_str = "STANDBY )";
   color  status_color = C'0,255,0';
   if(b_buy)  { status_str = "RUNNING: ขา [BUY] สวน"; status_color = C'30,144,255'; }
   if(b_sell) { status_str = "RUNNING: ขา [SELL] สวน"; status_color = C'255,69,0'; }
   color spread_color = (spread > MaxSpread) ? C'255,0,0' : C'240,240,240';

   string safety_status = "Safety Status: OK";
   color  safety_color  = C'0,255,127';
   if(floating_money < 0 && balance > 0)
   {
      double dd_perc = (MathAbs(floating_money)/balance)*100.0;
      safety_status = "DD Float: -" + DoubleToString(dd_perc,1) + "%";
      safety_color  = (dd_perc > MaxDrawdownPercent*0.7) ? C'255,69,0' : C'255,215,0';
   }

   ObjectSetString(0, panel_name+"_L1", OBJPROP_TEXT, "Account: " + (string)AccountInfoInteger(ACCOUNT_LOGIN) + " ("+AccountInfoString(ACCOUNT_CURRENCY)+")");
   ObjectSetString(0, panel_name+"_L2", OBJPROP_TEXT, "Balance: " + DoubleToString(balance, 2) + "  |  Equity: " + DoubleToString(equity, 2));
   ObjectSetString(0, panel_name+"_L3", OBJPROP_TEXT, "Spread: " + (string)spread + " Pts (Max: " + (string)MaxSpread + ")");
   ObjectSetInteger(0, panel_name+"_L3", OBJPROP_COLOR, spread_color);
   
   // เปลี่ยนจากตัวแปร CrashPoints เดิม เป็น CurrentCrashPoints เพื่อให้สะท้อนค่าที่สลับอยู่จริงบน Dashboard
   ObjectSetString(0, panel_name+"_L4", OBJPROP_TEXT, "M5 Candle Move: " + DoubleToString(m5_dist, 0) + " / " + (string)CurrentCrashPoints + " Pts");
   
   ObjectSetString(0, panel_name+"_L5", OBJPROP_TEXT, "----------------------------------------------------");
   
   ObjectSetString(0, panel_name+"_L6", OBJPROP_TEXT, "EA Status: " + status_str);
   ObjectSetInteger(0, panel_name+"_L6", OBJPROP_COLOR, status_color);
   ObjectSetString(0, panel_name+"_L7", OBJPROP_TEXT, "Active Orders: " + (string)total_pos + " / " + (string)MaxOpenPositions + "");
   ObjectSetString(0, panel_name+"_L8", OBJPROP_TEXT, "Current Grid Step: " + DoubleToString(current_step_pts, 0) + " Pts");
   ObjectSetString(0, panel_name+"_L9", OBJPROP_TEXT, "Total Open Lots: " + DoubleToString(total_open_lots, 2) + " Lots");
   ObjectSetString(0, panel_name+"_L10", OBJPROP_TEXT, "----------------------------------------------------");

   ObjectSetString(0, panel_name+"_L11", OBJPROP_TEXT, "💰 PROFIT PERFORMANCE STATS");
   ObjectSetInteger(0, panel_name+"_L11", OBJPROP_COLOR, C'255,215,0'); 
   ObjectSetString(0, panel_name+"_L12", OBJPROP_TEXT, "• Profit Today: " + DoubleToString(p_day, 2));
   ObjectSetInteger(0, panel_name+"_L12", OBJPROP_COLOR, (p_day >= 0)? C'0,255,127' : C'255,99,71');
   ObjectSetString(0, panel_name+"_L13", OBJPROP_TEXT, "• Profit This Month: " + DoubleToString(p_month, 2));
   ObjectSetInteger(0, panel_name+"_L13", OBJPROP_COLOR, (p_month >= 0)? C'0,255,127' : C'255,99,71');
   ObjectSetString(0, panel_name+"_L14", OBJPROP_TEXT, "• Profit This Year: " + DoubleToString(p_year, 2));
   ObjectSetInteger(0, panel_name+"_L14", OBJPROP_COLOR, (p_year >= 0)? C'0,255,127' : C'255,99,71');

   if(total_pos > 0)
   {
      double dist_to_tp = (b_buy) ? (global_target_tp - tick.bid) : (tick.ask - global_target_tp);
      ObjectSetString(0, panel_name+"_L15", OBJPROP_TEXT, safety_status + "  |  To TP: " + DoubleToString(dist_to_tp / _Point, 0) + " Pts");
      ObjectSetInteger(0, panel_name+"_L15", OBJPROP_COLOR, safety_color);
   }
   else
   {
      ObjectSetString(0, panel_name+"_L15", OBJPROP_TEXT, "Next Initial Lot: " + DoubleToString(CalculateAutoLot(), 2));
      ObjectSetInteger(0, panel_name+"_L15", OBJPROP_COLOR, C'220,220,220');
   }
}

//+------------------------------------------------------------------+
//| ฟังก์ชันดึงราคาเปิดของแท่งเทียน PERIOD_M5                          |
//+------------------------------------------------------------------+
double GetM5OpenPrice()
{
   double open_prices[1];
   if(CopyOpen(_Symbol, PERIOD_M5, 0, 1, open_prices) > 0)
   {
      return open_prices[0];
   }
   return 0;
}

//+------------------------------------------------------------------+
//| ฟังก์ชันตรวจสอบสถานะออเดอร์ในพอร์ต                                 |
//+------------------------------------------------------------------+
int CheckExistingPositions(bool &has_buy, bool &has_sell)
{
   has_buy = false;
   has_sell = false;
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         long pos_type = PositionGetInteger(POSITION_TYPE);
         if(pos_type == POSITION_TYPE_BUY)  has_buy = true;
         if(pos_type == POSITION_TYPE_SELL) has_sell = true;
         count++;
      }
   }
   return count;
}

//+------------------------------------------------------------------+
//| ฟังก์ชันคำนวณ Auto Lot อัตโนมัติตามเงินทุน                           |
//+------------------------------------------------------------------+
double CalculateAutoLot()
{
   double lot = BaseLot;
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   
   double min_broker_lot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double max_broker_lot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lot_step        = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(LotType == LOT_FIXED)
   {
      lot = BaseLot;
   }
   else if(LotType == LOT_PER_BALANCE)
   {
      if(CapitalAmount > 0)
      {
         lot = (balance / CapitalAmount) * LotPerCapital;
      }
   }
   else if(LotType == LOT_RISK_PERC)
   {
      double tick_value = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
      double tick_size  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
      
      if(tick_size > 0 && CurrentCrashPoints > 0) // เปลี่ยนไปใช้ค่า Dynamic ในการคำนวณตามล็อตความเสี่ยง
      {
         double point_value = tick_value * (_Point / tick_size);
         double risk_money = balance * (RiskPercent / 100.0);
         lot = risk_money / (CurrentCrashPoints * point_value);
      }
   }

   int steps = (int)MathRound(lot / lot_step);
   lot = steps * lot_step;

   if(lot < min_broker_lot) lot = min_broker_lot;
   if(lot > max_broker_lot) lot = max_broker_lot;
   if(lot > MaxLot)         lot = MaxLot;

   return NormalizeDouble(lot, 2);
}

//+------------------------------------------------------------------+
//| ฟังก์ชันคำนวณระยะห่าง Grid                                         |
//+------------------------------------------------------------------+
double CalculateGridStep()
{
   if(!UseATRGrid) return FixDistance * _Point;

   double atr_values[1];
   if(CopyBuffer(atr_handle, 0, 1, 1, atr_values) > 0)
   {
      double dynamic_step = atr_values[0] * ATR_Multiplier;
      double min_step_value = MinGridSpace * _Point;
      
      if(dynamic_step < min_step_value) return min_step_value;
      return dynamic_step;
   }
   return FixDistance * _Point;
}

//+------------------------------------------------------------------+
//| ฟังก์ชันบริหารจัดการการออกไม้แก้                                       |
//+------------------------------------------------------------------+
void ManageGrid(ENUM_POSITION_TYPE pos_type, double current_price)
{
   double worst_price = (pos_type == POSITION_TYPE_BUY) ? 999999.0 : 0.0;
   double last_lot = BaseLot;
   int current_count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         if(PositionGetInteger(POSITION_TYPE) == pos_type)
         {
            current_count++; 
            double open_price = PositionGetDouble(POSITION_PRICE_OPEN);
            last_lot = PositionGetDouble(POSITION_VOLUME);
            
            if(pos_type == POSITION_TYPE_BUY && (open_price > worst_price || worst_price == 999999.0))  worst_price = open_price;
            if(pos_type == POSITION_TYPE_SELL && (open_price < worst_price || worst_price == 0.0)) worst_price = open_price;
         }
      }
   }

   if(current_count >= MaxOpenPositions) return;

   datetime current_bar_time = iTime(_Symbol, PERIOD_M15, 0);
   if(AntiCluster && (current_bar_time == last_grid_bar)) return; 

   double distance = (pos_type == POSITION_TYPE_BUY) ? (worst_price - current_price) : (current_price - worst_price);
   double current_grid_step = CalculateGridStep();
   
   if(distance >= current_grid_step)
   {
      double next_lot = last_lot;
      
      if(MartiMode == MODE_MULTIPLIER)      next_lot = NormalizeDouble(last_lot * LotMultiplier, 2);
      else if(MartiMode == MODE_DOUBLE)     next_lot = NormalizeDouble(last_lot * 2.0, 2);
      else if(MartiMode == MODE_CUSTOM_STEP)
      {
         if(current_count <= 3) next_lot = NormalizeDouble(last_lot * CustomStep1_3, 2);
         else                   next_lot = NormalizeDouble(last_lot * CustomStep4_Up, 2);
      }
      
      if(next_lot > MaxLot) next_lot = MaxLot; 
      
      if(pos_type == POSITION_TYPE_BUY)  
      {
         if(trade.Buy(next_lot, _Symbol, current_price, 0, 0, "Grid Buy Fix"))
            last_grid_bar = current_bar_time; 
      }
      if(pos_type == POSITION_TYPE_SELL) 
      {
         if(trade.Sell(next_lot, _Symbol, current_price, 0, 0, "Grid Sell Fix"))
            last_grid_bar = current_bar_time; 
      }
   }
}

//+------------------------------------------------------------------+
//| ฟังก์ชันคำนวณและอัปเดต TP รวบ                                     |
//+------------------------------------------------------------------+
void UpdateAverageTP(ENUM_POSITION_TYPE pos_type)
{
   double total_lot = 0;
   double total_product = 0;
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         if(PositionGetInteger(POSITION_TYPE) == pos_type)
         {
            double open_price = PositionGetDouble(POSITION_PRICE_OPEN);
            double lot = PositionGetDouble(POSITION_VOLUME);
            
            total_lot += lot;
            total_product += (open_price * lot);
            count++;
         }
      }
   }

   if(count == 0) return;

   double break_even_price = total_product / total_lot;
   double target_tp_price = 0;

   if(pos_type == POSITION_TYPE_BUY)  target_tp_price = break_even_price + (TargetTP * _Point);
   if(pos_type == POSITION_TYPE_SELL) target_tp_price = break_even_price - (TargetTP * _Point);
   
   target_tp_price = NormalizeDouble(target_tp_price, _Digits);

   global_break_even = break_even_price;
   global_target_tp  = target_tp_price;

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   // เช็คว่าราคาปัจจุบันวิ่งทะลุจุดเริ่มระบบ Trailing ไปแล้วหรือไม่
   bool is_trailing_active = false;
   if(UseTrailing)
   {
      if(pos_type == POSITION_TYPE_BUY && tick.bid >= break_even_price + ((TargetTP + TrailingStart) * _Point)) is_trailing_active = true;
      if(pos_type == POSITION_TYPE_SELL && tick.ask <= break_even_price - ((TargetTP + TrailingStart) * _Point)) is_trailing_active = true;
   }

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         if(PositionGetInteger(POSITION_TYPE) == pos_type)
         {
            double current_tp = PositionGetDouble(POSITION_TP);
            
            // กรณีที่ 1: ถ้าระบบเทรลลิ่งยังไม่ทำงาน ให้ล็อกราคารวบ TP ตามปกติ
            if(!is_trailing_active)
            {
               if(MathAbs(current_tp - target_tp_price) > _Point)
               {
                  trade.PositionModify(ticket, PositionGetDouble(POSITION_SL), target_tp_price);
               }
            }
            // กรณีที่ 2: ถ้าระบบเทรลลิ่งเริ่มทำงานแล้ว ให้ลบราคารวบ TP ออก เพื่อปล่อยรันเทรนด์ด้วย SL
            else 
            {
               if(current_tp > 0)
               {
                  trade.PositionModify(ticket, PositionGetDouble(POSITION_SL), 0);
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| ฟังก์ชัน Trailing Stop คำนวณขยับตามราคารวมของพอร์ต               |
//+------------------------------------------------------------------+
void ApplyTrailingStop(ENUM_POSITION_TYPE pos_type, double price_for_sl)
{
   double total_lot = 0;
   double total_product = 0;
   int count = 0;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber)
      {
         if(PositionGetInteger(POSITION_TYPE) == pos_type)
         {
            total_lot += PositionGetDouble(POSITION_VOLUME);
            total_product += (PositionGetDouble(POSITION_PRICE_OPEN) * PositionGetDouble(POSITION_VOLUME));
            count++;
         }
      }
   }

   if(count == 0) return;
   double break_even_price = total_product / total_lot;

   if(pos_type == POSITION_TYPE_BUY)
   {
      // เริ่มทำงานเมื่อราคา bid (price_for_sl) สูงกว่าราคาบวก TP + ระยะเริ่มเทรล
      if(price_for_sl >= break_even_price + ((TargetTP + TrailingStart) * _Point))
      {
         double new_sl = NormalizeDouble(price_for_sl - (TrailingStop * _Point), _Digits);
         
         for(int i = PositionsTotal() - 1; i >= 0; i--)
         {
            if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber && PositionGetInteger(POSITION_TYPE) == pos_type)
            {
               ulong ticket = PositionGetTicket(i);
               double current_sl = PositionGetDouble(POSITION_SL);
               
               if(current_sl == 0 || new_sl >= current_sl + (TrailingStep * _Point))
               {
                  trade.PositionModify(ticket, new_sl, 0);
               }
            }
         }
      }
   }
   else if(pos_type == POSITION_TYPE_SELL)
   {
      // เริ่มทำงานเมื่อราคา ask (price_for_sl) ต่ำกว่าราคาลบ TP - ระยะเริ่มเทรล
      if(price_for_sl <= break_even_price - ((TargetTP + TrailingStart) * _Point))
      {
         double new_sl = NormalizeDouble(price_for_sl + (TrailingStop * _Point), _Digits);
         
         for(int i = PositionsTotal() - 1; i >= 0; i--)
         {
            if(PositionGetSymbol(i) == _Symbol && PositionGetInteger(POSITION_MAGIC) == MagicNumber && PositionGetInteger(POSITION_TYPE) == pos_type)
            {
               ulong ticket = PositionGetTicket(i);
               double current_sl = PositionGetDouble(POSITION_SL);
               
               if(current_sl == 0 || new_sl <= current_sl - (TrailingStep * _Point))
               {
                  trade.PositionModify(ticket, new_sl, 0);
               }
            }
         }
      }
   }
}