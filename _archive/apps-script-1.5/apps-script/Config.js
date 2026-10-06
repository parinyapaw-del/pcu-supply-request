// Config.js — constants shared across the backend. No secrets here (public repo).
// Mirrors webapp/js/constants.js (ROUNDS) and webapp/data/form2569.json (FORM_ITEMS).

var SHEET_NAMES = {
  CONFIG: "config",
  ADMINS: "admins",
  PCUS: "pcus",
  ITEM_MAP: "item_map",
  ACTUAL: "actual_2568",
  PLAN: "plan_2568",
  STATS: "stats_2568",
  STOCK_SIM: "stock_sim_2568",
  LIMITS: "limits",
  REQUESTS: "requests",
  REQUEST_LINES: "request_lines",
  HIDDEN: "pcu_hidden_items",
  AUDIT: "audit_log"
};

// FY2568 seed months, oldest (index 0) to newest (index 11).
var SEED_MONTHS = [
  "2024-10", "2024-11", "2024-12", "2025-01", "2025-02", "2025-03",
  "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09"
];

// Trial rounds (API.md "Constants"). `month` is the CE key used everywhere in the API.
var ROUNDS = [
  { month: "2025-09", label: "ก.ย. 2568", fy: 2568, deadlineLabel: "25 ก.ย. 2568", prevMonth: "2025-08", default: true },
  { month: "2025-10", label: "ต.ค. 2568", fy: 2569, deadlineLabel: "25 ต.ค. 2568", prevMonth: "2025-09", next: true }
];

var PIN_LENGTH = 5;
var PIN_MAX_FAIL = 5;
var PIN_LOCK_MIN = 5;
var PCU_TOKEN_DAYS = 7;
var ADMIN_TOKEN_HOURS = 12;
var BACKUP_MAX_FAIL = 5;
var BACKUP_LOCK_MIN = 15;

var DEFAULT_ADMIN_EMAIL = "parinya.paw@gmail.com";
// Same OAuth Web Client ID as webapp/js/constants.js GOOGLE_CLIENT_ID (public, not a secret).
var GOOGLE_CLIENT_ID = "572074800379-jtl1af4cat6v8vk8u4r3o868r7lskfab.apps.googleusercontent.com";

var DEFAULT_CONFIG = {
  limit_mode: "warn",
  cover_over: "3",
  cover_short: "0.5",
  budget_op: "520000",
  budget_pp: "390000",
  budget_total: "910000"
};

// The 125 items on the 2569 form (webapp/data/form2569.json), embedded here so the backend can
// validate item codes / build item_map without re-parsing that file. Public, non-secret data.
var FORM_ITEMS = [{"code":"P1-01","step":"P1","name":"ถุงใส่ขยะสีดำ 13\" * 21\" (41 ใบ/ห่อ/1 kg.)","unit":"ห่อ","price":49.0},{"code":"P1-02","step":"P1","name":"ถุงใส่ขยะสีดำ 16\" * 28\" (26 ใบ/ห่อ/1 kg.)","unit":"ห่อ","price":49.0},{"code":"P1-03","step":"P1","name":"ถุงใส่ขยะสีแดง 13\" * 21\" (41 ใบ/ห่อ/1 kg.)","unit":"ห่อ","price":66.0},{"code":"P1-04","step":"P1","name":"ถุงใส่ขยะสีแดง 16\" * 28\" (26 ใบ/ห่อ/1 kg.)","unit":"ห่อ","price":66.0},{"code":"P1-05","step":"P1","name":"สมุดส่งผู้ป่วยไปรับการตรวจหรือรักษาต่อ","unit":"เล่ม","price":150.0},{"code":"P1-06","step":"P1","name":"สติกเกอร์ติด Tube","unit":"ดวง","price":0.3},{"code":"P1-07","step":"P1","name":"ใบ Lab สีเหลือง","unit":"เล่ม","price":75.0},{"code":"P1-08","step":"P1","name":"ใบ Lab สีชมพู","unit":"เล่ม","price":75.0},{"code":"P1-09","step":"P1","name":"ใบ Lab สีฟ้า","unit":"เล่ม","price":75.0},{"code":"P1-10","step":"P1","name":"ใบเบิก - ใบส่งคืน / แบบ พ.3101","unit":"เล่ม","price":225.0},{"code":"P1-11","step":"P1","name":"ขวดเปล่า 300 CC.","unit":"ขวด","price":19.0},{"code":"P1-12","step":"P1","name":"หมวกคลุมผม เฉพาะ บริการทันตกรรม","unit":"ชิ้น","price":0.85},{"code":"P1-13","step":"P1","name":"Autoclave Tape 3/4\"","unit":"ม้วน","price":235.4},{"code":"P1-14","step":"P1","name":"Face Mask (50 ชิ้น/กล่อง)","unit":"กล่อง","price":41.73},{"code":"P1-15","step":"P1","name":"ใบมีดผ่าตัด No.11 (100 ใบ/กล่อง)","unit":"กล่อง","price":310.0},{"code":"P1-16","step":"P1","name":"Set Saline ชุดให้น้ำเกลือ (NIPO)","unit":"ชุด","price":10.7},{"code":"P1-17","step":"P1","name":"K-Y Gel","unit":"ซอง","price":4.0},{"code":"P1-18","step":"P1","name":"ไม้กดลิ้น (100 ชิ้น/กล่อง)","unit":"กล่อง","price":110.0},{"code":"P1-19","step":"P1","name":"Mask N95 (ให้ รพ.สต. แห่งละ 5 ชิ้น/ปี)","unit":"ชิ้น","price":25.0},{"code":"P1-20","step":"P1","name":"Air-way No.3","unit":"ชิ้น","price":16.0},{"code":"P1-21","step":"P1","name":"Air-way No.4","unit":"ชิ้น","price":16.0},{"code":"P1-22","step":"P1","name":"Air-way No.5","unit":"ชิ้น","price":16.0},{"code":"P2-01","step":"P2","name":"Oxgen cannula","unit":"ชุด","price":10.5},{"code":"P2-02","step":"P2","name":"Oxgen Mask with bag adult","unit":"ชิ้น","price":24.0},{"code":"P2-03","step":"P2","name":"Oxgen Mask with bag childen","unit":"ชิ้น","price":24.0},{"code":"P2-04","step":"P2","name":"ไม้ pap smear (100 ชิ้น/กล่อง)","unit":"กล่อง","price":123.5},{"code":"P2-05","step":"P2","name":"สไลด์ pap smear (100 แผ่น/กล่อง)","unit":"กล่อง","price":38.5},{"code":"P2-06","step":"P2","name":"DISPOS NEEDLE NO. 18*1\"","unit":"ชิ้น","price":0.42},{"code":"P2-07","step":"P2","name":"DISPOS NEEDLE NO. 18*1.5\"","unit":"ชิ้น","price":0.06},{"code":"P2-08","step":"P2","name":"DISPOS NEEDLE NO. 20*1\"","unit":"ชิ้น","price":0.42},{"code":"P2-09","step":"P2","name":"DISPOS NEEDLE NO. 20*1.5\"","unit":"ชิ้น","price":0.42},{"code":"P2-10","step":"P2","name":"DISPOS NEEDLE NO. 21*1\"","unit":"ชิ้น","price":0.41},{"code":"P2-11","step":"P2","name":"DISPOS NEEDLE NO. 21*1.5\"","unit":"ชิ้น","price":0.05},{"code":"P2-12","step":"P2","name":"DISPOS NEEDLE NO. 22*1\"","unit":"ชิ้น","price":0.41},{"code":"P2-13","step":"P2","name":"DISPOS NEEDLE NO. 22*1.5\"","unit":"ชิ้น","price":0.42},{"code":"P2-14","step":"P2","name":"DISPOS NEEDLE NO. 23*1\"","unit":"ชิ้น","price":0.41},{"code":"P2-15","step":"P2","name":"DISPOS NEEDLE NO. 23*1.5\"","unit":"ชิ้น","price":0.42},{"code":"P2-16","step":"P2","name":"DISPOS NEEDLE NO. 24*1\"","unit":"ชิ้น","price":0.41},{"code":"P2-17","step":"P2","name":"DISPOS NEEDLE NO. 24*1.5\"","unit":"ชิ้น","price":0.41},{"code":"P2-18","step":"P2","name":"DISPOS NEEDLE NO. 25*1\"","unit":"ชิ้น","price":0.41},{"code":"P2-19","step":"P2","name":"DISPOS NEEDLE NO. 25*1.5\"","unit":"ชิ้น","price":0.41},{"code":"P2-20","step":"P2","name":"DISPOS NEEDLE NO. 26*0.5\"","unit":"ชิ้น","price":0.41},{"code":"P2-21","step":"P2","name":"DISPOS NEEDLE NO. 27*0.5\"","unit":"ชิ้น","price":0.42},{"code":"P2-22","step":"P2","name":"ELASTIC BANDAGE 2\"","unit":"ม้วน","price":7.92},{"code":"P2-23","step":"P2","name":"ELASTIC BANDAGE 3\"","unit":"ม้วน","price":11.23},{"code":"P3-01","step":"P3","name":"ELASTIC BANDAGE 4\"","unit":"ม้วน","price":14.58},{"code":"P3-02","step":"P3","name":"ELASTIC BANDAGE 6\"","unit":"ม้วน","price":21.67},{"code":"P3-03","step":"P3","name":"FOLEY CATHETER 2 WAY NO.8","unit":"ชิ้น","price":28.0},{"code":"P3-04","step":"P3","name":"FOLEY CATHETER 2 WAY NO.10","unit":"ชิ้น","price":28.0},{"code":"P3-05","step":"P3","name":"FOLEY CATHETER 2 WAY NO.12","unit":"ชิ้น","price":17.21},{"code":"P3-06","step":"P3","name":"FOLEY CATHETER 2 WAY NO.14","unit":"ชิ้น","price":14.5},{"code":"P3-07","step":"P3","name":"FOLEY CATHETER 2 WAY NO.16","unit":"ชิ้น","price":14.5},{"code":"P3-08","step":"P3","name":"FOLEY CATHETER 2 WAY NO.18","unit":"ชิ้น","price":14.5},{"code":"P3-09","step":"P3","name":"FOLEY CATHETER 2 WAY NO.20","unit":"ชิ้น","price":14.5},{"code":"P3-10","step":"P3","name":"FOLEY CATHETER 2 WAY NO.22","unit":"ชิ้น","price":15.7},{"code":"P3-11","step":"P3","name":"FOLEY CATHETER 2 WAY NO.24","unit":"ชิ้น","price":24.77},{"code":"P3-12","step":"P3","name":"FOLEY CATHETER 3 WAY NO.18","unit":"ชิ้น","price":28.0},{"code":"P3-13","step":"P3","name":"FOLEY CATHETER 3 WAY NO.20","unit":"ชิ้น","price":28.0},{"code":"P3-14","step":"P3","name":"FOLEY CATHETER 3 WAY NO.22","unit":"ชิ้น","price":28.0},{"code":"P3-15","step":"P3","name":"FOLEY CATHETER 3 WAY NO.24","unit":"ชิ้น","price":28.0},{"code":"P3-16","step":"P3","name":"GAUZE (สำเร็จรูป) 3*4\" NON STERILE (100แผ่น/ห่อ)","unit":"ห่อ","price":42.8},{"code":"P3-17","step":"P3","name":"GAUZE BANDAGE 36\"* 6 YDS.","unit":"ม้วน","price":44.94},{"code":"P3-18","step":"P3","name":"IV CATHETER NO.16","unit":"ชิ้น","price":8.7},{"code":"P3-19","step":"P3","name":"IV CATHETER NO.18","unit":"ชิ้น","price":8.21},{"code":"P3-20","step":"P3","name":"IV CATHETER NO.20","unit":"ชิ้น","price":7.53},{"code":"P3-21","step":"P3","name":"IV CATHETER NO.22","unit":"ชิ้น","price":7.2},{"code":"P3-22","step":"P3","name":"IV CATHETER NO.24","unit":"ชิ้น","price":21.4},{"code":"P3-23","step":"P3","name":"MICROPORE 1/2\"*10 YDS.","unit":"ม้วน","price":7.94},{"code":"P4-01","step":"P4","name":"MICROPORE 1\"*10 YDS.","unit":"ม้วน","price":15.87},{"code":"P4-02","step":"P4","name":"NG TUBE NO.10*125 CM.","unit":"ชิ้น","price":8.83},{"code":"P4-03","step":"P4","name":"NG TUBE NO.12*125 CM.","unit":"ชิ้น","price":7.64},{"code":"P4-04","step":"P4","name":"NG TUBE NO.14*125 CM.","unit":"ชิ้น","price":7.8},{"code":"P4-05","step":"P4","name":"NG TUBE NO.16*125 CM.","unit":"ชิ้น","price":7.8},{"code":"P4-06","step":"P4","name":"NG TUBE NO.18*125 CM.","unit":"ชิ้น","price":7.8},{"code":"P4-07","step":"P4","name":"SOFRA - TULLE","unit":"ชิ้น","price":9.52},{"code":"P4-08","step":"P4","name":"SYRINGE DISPOS 1 ML. (ไม่ติดเข็ม)","unit":"ชิ้น","price":0.0},{"code":"P4-09","step":"P4","name":"SYRINGE DISPOS 1 ML. (ถอดหัวเข็มได้ 25*1\" LDS)","unit":"ชิ้น","price":0.05},{"code":"P4-10","step":"P4","name":"SYRINGE INSULIN DISPOS 100 UNIT (29*0.5)","unit":"ชิ้น","price":1.85},{"code":"P4-11","step":"P4","name":"SYRINGE DISPOS 3 ML.","unit":"ชิ้น","price":1.06},{"code":"P4-12","step":"P4","name":"SYRINGE DISPOS 5 ML.","unit":"ชิ้น","price":1.16},{"code":"P4-13","step":"P4","name":"SYRINGE DISPOS 10 ML.","unit":"ชิ้น","price":1.54},{"code":"P4-14","step":"P4","name":"SYRINGE DISPOS 20 ML.","unit":"ชิ้น","price":3.3},{"code":"P4-15","step":"P4","name":"SYRINGE DISPOS 50 ML.","unit":"ชิ้น","price":8.67},{"code":"P4-16","step":"P4","name":"THERMOMETER DIGITAL (ยี่ห้อ TERUMO)","unit":"ชิ้น","price":642.0},{"code":"P4-17","step":"P4","name":"TRANSPORE 1\"","unit":"ชิ้น","price":21.03},{"code":"P4-18","step":"P4","name":"URINE BAG","unit":"ชิ้น","price":14.5},{"code":"P4-19","step":"P4","name":"ถุงมือตรวจโรค DISPOSABLE NO.XS","unit":"กล่อง","price":93.85},{"code":"P4-20","step":"P4","name":"ถุงมือตรวจโรค DISPOSABLE NO.S","unit":"กล่อง","price":93.99},{"code":"P4-21","step":"P4","name":"ถุงมือตรวจโรค DISPOSABLE NO.M","unit":"กล่อง","price":93.99},{"code":"P4-22","step":"P4","name":"ถุงมือตรวจโรค DISPOSABLE NO.L","unit":"กล่อง","price":93.7},{"code":"P4-23","step":"P4","name":"สำลี (สำเร็จรูป) 0.35 g. (450 กรัม/ถุง)","unit":"ถุง","price":70.0},{"code":"P4-24","step":"P4","name":"สำลี (สำเร็จรูป) 1.40 g. (450 กรัม/ถุง)","unit":"ถุง","price":70.0},{"code":"P5-01","step":"P5","name":"ไม้พันสำลี 2 ก้าน (ต้องโทรแจ้งก่อน 1 เดือน)","unit":"ซอง","price":1.25},{"code":"P5-02","step":"P5","name":"Gauze drain 5\" (ต้องโทรแจ้งก่อน 1 เดือน)","unit":"ซอง","price":3.15},{"code":"P5-03","step":"P5","name":"สำลี + แอลกอฮอร์ 8 ก้อน/แผง","unit":"แผง","price":4.0},{"code":"P5-04","step":"P5","name":"ถุงมือ sterile เบอร์ XS","unit":"คู่","price":9.39},{"code":"P5-05","step":"P5","name":"ถุงมือ sterile เบอร์ S","unit":"คู่","price":9.39},{"code":"P5-06","step":"P5","name":"ถุงมือ sterile เบอร์ M","unit":"คู่","price":9.39},{"code":"P5-07","step":"P5","name":"ก๊อส 5 แผ่น (ใช้ในงานหัตถการ)","unit":"ซอง","price":4.0},{"code":"P5-08","step":"P5","name":"สำลี (0.35 g.) 10 ก้อน","unit":"ซอง","price":3.0},{"code":"P5-09","step":"P5","name":"TOP Gauze 11*12\" (2 ชิ้น/ซอง) (ต้องโทรแจ้งก่อน 1 เดือน)","unit":"ซอง","price":40.45},{"code":"CS-01","step":"CS","name":"TOP Gauze 3*6\" (4 ชิ้น/ซอง) (ต้องโทรแจ้งก่อน 1 เดือน)","unit":"ซอง","price":12.89},{"code":"CS-02","step":"CS","name":"Comply (ใช้ตรวจ Set ทันตกรรม/หัตถการ)","unit":"แผ่น","price":6.4},{"code":"CS-03","step":"CS","name":"spore test","unit":"ชิ้น","price":150.0},{"code":"LAB-01","step":"LAB","name":"แผ่นตรวจ urine Preg test ","unit":"แผ่น","price":4.0},{"code":"LAB-02","step":"LAB","name":"แผ่นตรวจ Urine sugar / Albumine (100 แผ่น/กล่อง)","unit":"กล่อง","price":120.0},{"code":"LAB-03","step":"LAB","name":"แผ่นตรวจน้ำตาลปลายนิ้ว","unit":"แผ่น","price":5.1},{"code":"LAB-04","step":"LAB","name":"เข็มเจาะเลือดปลายนิ้ว","unit":"อัน","price":4.5},{"code":"LAB-05","step":"LAB","name":"Tube FBS สีเทา","unit":"อัน","price":2.2},{"code":"LAB-06","step":"LAB","name":"Tube CBC (EDTA) สีม่วง","unit":"อัน","price":2.2},{"code":"LAB-07","step":"LAB","name":"Tube clot blood  (Heparin) สีเขียว","unit":"อัน","price":1.75},{"code":"LAB-08","step":"LAB","name":"กระป๋องใส่ปัสสาวะ","unit":"ใบ","price":1.5},{"code":"LAB-09","step":"LAB","name":"HCT tube (100 tube/ขวด)","unit":"ขวด","price":58.0},{"code":"LAB-10","step":"LAB","name":"ชุดทดสอบสารฆ่าแมลง MJPK (10 test)","unit":"กล่อง","price":575.0},{"code":"LAB-11","step":"LAB","name":"ชุดทดสอบไอโอดีน I-kit (60 test)","unit":"กล่อง","price":100.0},{"code":"LAB-12","step":"LAB","name":"ชุดทดสอบกันรา (50 test)","unit":"กล่อง","price":120.0},{"code":"LAB-13","step":"LAB","name":"ชุดทดสอบสารบอแรกซ์  (50 test)","unit":"กล่อง","price":90.0},{"code":"LAB-14","step":"LAB","name":"ชุดทดสอบสารฟอกขาว  (100 test)","unit":"กล่อง","price":85.0},{"code":"LAB-15","step":"LAB","name":"ชุดทดสอบสารฟอร์มาลีน  (1 test)","unit":"กล่อง","price":18.0},{"code":"LAB-16","step":"LAB","name":"ชุดทดสอบโพลาร์ในน้ำมันทอดซ้ำ  (25 test)","unit":"กล่อง","price":500.0},{"code":"LAB-17","step":"LAB","name":"ชุดทดสอบไฮโดรควืนิน  (20 test)","unit":"กล่อง","price":400.0},{"code":"LAB-18","step":"LAB","name":"ชุดทดสอบปรอท  (10 test)","unit":"กล่อง","price":800.0},{"code":"LAB-19","step":"LAB","name":"ชุดทดสอบสาร steroids ในยาแผนโบราณ (10 test)","unit":"กล่อง","price":650.0},{"code":"LAB-20","step":"LAB","name":"ชุดทดสอบกรดวิตามิน A  (25 test)","unit":"กล่อง","price":550.0},{"code":"LAB-21","step":"LAB","name":"ชุดทดสอบโคลิฟอร์มแบคทีเรีย SI-2 (1 test)","unit":"ขวด","price":12.0}];

var ITEM_CODES = ["P1-01","P1-02","P1-03","P1-04","P1-05","P1-06","P1-07","P1-08","P1-09","P1-10","P1-11","P1-12","P1-13","P1-14","P1-15","P1-16","P1-17","P1-18","P1-19","P1-20","P1-21","P1-22","P2-01","P2-02","P2-03","P2-04","P2-05","P2-06","P2-07","P2-08","P2-09","P2-10","P2-11","P2-12","P2-13","P2-14","P2-15","P2-16","P2-17","P2-18","P2-19","P2-20","P2-21","P2-22","P2-23","P3-01","P3-02","P3-03","P3-04","P3-05","P3-06","P3-07","P3-08","P3-09","P3-10","P3-11","P3-12","P3-13","P3-14","P3-15","P3-16","P3-17","P3-18","P3-19","P3-20","P3-21","P3-22","P3-23","P4-01","P4-02","P4-03","P4-04","P4-05","P4-06","P4-07","P4-08","P4-09","P4-10","P4-11","P4-12","P4-13","P4-14","P4-15","P4-16","P4-17","P4-18","P4-19","P4-20","P4-21","P4-22","P4-23","P4-24","P5-01","P5-02","P5-03","P5-04","P5-05","P5-06","P5-07","P5-08","P5-09","CS-01","CS-02","CS-03","LAB-01","LAB-02","LAB-03","LAB-04","LAB-05","LAB-06","LAB-07","LAB-08","LAB-09","LAB-10","LAB-11","LAB-12","LAB-13","LAB-14","LAB-15","LAB-16","LAB-17","LAB-18","LAB-19","LAB-20","LAB-21"];

var ITEM_CODE_SET = (function () {
  var s = {};
  for (var i = 0; i < ITEM_CODES.length; i++) s[ITEM_CODES[i]] = true;
  return s;
})();

// Items that exist on the 2569 form but have no FY2568 history (new items) — excluded from
// "never withdrawn in FY68" (never68) regardless of presence/absence in actual_2568.
var NEW_2569_ITEMS = { "P5-09": true, "CS-01": true };

// Extra (non-form) item counted only in admin baht totals (spec §2.1/§2.2, key "113" in seed).
var EXTRA_ITEM_CODE = "X-113";

var FORM_ITEM_BY_CODE_ = (function () {
  var m = {};
  for (var i = 0; i < FORM_ITEMS.length; i++) m[FORM_ITEMS[i].code] = FORM_ITEMS[i];
  return m;
})();
