/**
 * 「AI物聯網實驗室」課程二:ESP32 物聯網
 *
 * 內容以 src/data/examples.ts、examples-circuits.ts、
 * examples-esp32-mqtt.ts 中的真實 ESP32 範例為基礎。
 * lesson id 是進度記錄的永久鍵值,發布後不可更改。
 */
import type { Course } from './types';

export const esp32IotCourse: Course = {
  id: 'esp32-iot',
  title: 'ESP32 物聯網',
  description:
    '帶著 Arduino 基礎升級到 ESP32:認識 WiFi 開發板、架設自己的網頁伺服器、再用 MQTT 把感測器資料送上雲端,完整走一遍物聯網的資料旅程。',
  level: '進階',
  emoji: '📡',
  lessons: [
    // ─────────────────────────────────────────────────────────────
    {
      id: 'intro',
      title: '認識 ESP32',
      minutes: 15,
      exampleId: 'esp32-blink-led',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 了解 ESP32 與 Arduino Uno 的主要差異(WiFi、藍牙、3.3V、雙核心)\n' +
            '- 認識 GPIO 編號方式,知道內建 LED 在 GPIO2\n' +
            '- 在模擬器成功執行第一個 ESP32 程式',
        },
        {
          heading: '原理解說',
          markdown:
            'ESP32 是物聯網世界的明星晶片。跟 Arduino Uno 比一比:\n\n' +
            '| 項目 | Arduino Uno | ESP32 |\n' +
            '| --- | --- | --- |\n' +
            '| 處理器 | 單核心 16MHz | **雙核心 240MHz**(快上百倍) |\n' +
            '| 網路 | 無 | **內建 WiFi + 藍牙** |\n' +
            '| 工作電壓 | 5V | **3.3V**(接腳不可接 5V!) |\n' +
            '| 接腳名稱 | 數位 0~13、類比 A0~A5 | 統一叫 **GPIO**,例如 GPIO2、GPIO4 |\n' +
            '| ADC | 10 位元(0~1023) | 12 位元(0~4095) |\n\n' +
            '寫程式的方式幾乎一樣:setup()、loop()、pinMode()、digitalWrite() 全部通用,' +
            '所以你在 Arduino 課學的東西都帶得過來。\n\n' +
            '**模擬器小提醒**:ESP32 是在伺服器端用完整的 QEMU 模擬器執行,' +
            '編譯和啟動都比 Uno **慢一些**,按下執行後請耐心等待。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例同時控制內建 LED(GPIO2)和外接 LED(GPIO4):\n\n' +
            '```cpp\n' +
            '#define LED_BUILTIN_PIN 2   // ESP32 開發板內建藍色 LED\n' +
            '#define LED_EXT_PIN     4   // 外接紅色 LED\n' +
            '\n' +
            'void setup() {\n' +
            '  Serial.begin(115200);\n' +
            '  pinMode(LED_BUILTIN_PIN, OUTPUT);\n' +
            '  pinMode(LED_EXT_PIN, OUTPUT);\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  digitalWrite(LED_BUILTIN_PIN, HIGH);\n' +
            '  digitalWrite(LED_EXT_PIN, HIGH);\n' +
            '  Serial.println("LED ON");\n' +
            '  delay(500);\n' +
            '\n' +
            '  digitalWrite(LED_BUILTIN_PIN, LOW);\n' +
            '  digitalWrite(LED_EXT_PIN, LOW);\n' +
            '  Serial.println("LED OFF");\n' +
            '  delay(500);\n' +
            '}\n' +
            '```\n\n' +
            '兩個跟 Uno 不同的地方:\n\n' +
            '- **Serial.begin(115200)**:ESP32 慣用 115200 的鮑率(Uno 課多半用 9600),' +
            '序列埠監控視窗要選對速度才看得到字。\n' +
            '- 內建 LED 在 **GPIO2**,不是 Uno 的接腳 13。',
        },
        {
          heading: '接線說明',
          markdown:
            '外接 LED 的接法跟 Uno 課完全相同的「訊號 → 電阻 → LED → GND」:\n\n' +
            '| 起點 | 終點 | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| ESP32 GPIO4 | 電阻 220Ω 一端 | 訊號輸出 |\n' +
            '| 電阻另一端 | LED 陽極(A) | 限流後進入 LED |\n' +
            '| LED 陰極(C) | ESP32 GND | 完成迴路 |\n\n' +
            '注意:ESP32 是 3.3V 系統,(3.3V − 2V) ÷ 220Ω ≈ 6mA,LED 會比 5V 時稍暗,但一樣安全。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '讓兩顆 LED **交替**閃爍:內建 LED 亮的時候外接 LED 暗,反之亦然' +
        '(提示:把其中一組 HIGH/LOW 對調)。\n\n' +
        '再觀察序列埠監控視窗的 LED ON / LED OFF 訊息是否跟燈號同步。' +
        '有問題可以問 AI 助教:「ESP32 跟 Uno 的程式有什麼要改的?」',
      quiz: [
        {
          id: 'q1',
          question: 'ESP32 比 Arduino Uno 多了哪個重要功能?',
          options: ['內建 WiFi 與藍牙', '更多 5V 接腳', '內建螢幕', '不需要電源'],
          answer: 0,
          explanation: 'ESP32 晶片內建 WiFi 和藍牙,天生適合做物聯網裝置。',
        },
        {
          id: 'q2',
          question: 'ESP32 的接腳工作電壓是多少?',
          options: ['12V', '5V', '3.3V', '1.5V'],
          answer: 2,
          explanation: 'ESP32 是 3.3V 系統,接腳直接接 5V 訊號可能會損壞晶片。',
        },
        {
          id: 'q3',
          question: 'ESP32 開發板的內建 LED 接在哪支接腳?',
          options: ['GPIO13', 'GPIO0', 'GPIO2', 'GPIO4'],
          answer: 2,
          explanation: '範例中 LED_BUILTIN_PIN 定義為 2,ESP32 DevKit 的內建藍色 LED 在 GPIO2。',
        },
        {
          id: 'q4',
          question: '在模擬器中執行 ESP32 程式,為什麼比 Uno 慢?',
          options: [
            'ESP32 晶片本身比較慢',
            'ESP32 在伺服器端用完整系統模擬器(QEMU)編譯與執行',
            '網路太慢',
            '程式碼比較長',
          ],
          answer: 1,
          explanation: 'ESP32 的模擬在伺服器端進行完整編譯與開機流程,啟動時間自然比瀏覽器內的 AVR 模擬長。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'serial',
      title: '序列埠通訊',
      minutes: 10,
      exampleId: 'esp32-serial-echo',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 熟悉 Serial.begin(115200) 與序列埠監控視窗的雙向溝通\n' +
            '- 學會用 Serial.available() 和 readStringUntil() 讀取輸入\n' +
            '- 理解「回音(echo)」程式的運作流程',
        },
        {
          heading: '原理解說',
          markdown:
            '序列埠(Serial)是開發板跟電腦之間的**對講機**:' +
            '之前我們只用它「單向」印訊息,這一課要**雙向**——你打字給 ESP32,它再回覆你。\n\n' +
            '關鍵概念:\n\n' +
            '- **鮑率(baud rate)**:雙方講話的速度,必須一致才聽得懂。ESP32 慣用 **115200**。\n' +
            '- **緩衝區**:你送出的文字先存在接收緩衝區,程式用 Serial.available() 檢查「有沒有新資料」,' +
            '有才去讀——就像先看信箱有沒有信,再開箱拿信。\n\n' +
            '這種「收到什麼就回什麼」的程式叫 **echo(回音)**,是測試通訊是否正常的經典方法。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例完整邏輯:\n\n' +
            '```cpp\n' +
            'void setup() {\n' +
            '  Serial.begin(115200);\n' +
            '  Serial.println("ESP32 Serial Echo ready!");\n' +
            '  Serial.println("Type anything in the Serial Monitor...");\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  if (Serial.available()) {\n' +
            "    String input = Serial.readStringUntil('\\n');\n" +
            '    input.trim();\n' +
            '    if (input.length() > 0) {\n' +
            '      Serial.print("Echo: ");\n' +
            '      Serial.println(input);\n' +
            '    }\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            '- **Serial.available()**:回傳緩衝區裡的位元組數,大於 0 表示有資料可讀。\n' +
            "- **readStringUntil('\\n')**:一直讀到換行字元為止,拿到一整行文字。\n" +
            '- **trim()**:去掉頭尾的空白和換行,避免比對時出錯。\n\n' +
            '操作方式:執行後打開序列埠監控視窗(鮑率 115200),在輸入框打字送出,' +
            'ESP32 會回覆「Echo: 你打的字」。',
        },
        {
          heading: '延伸思考',
          markdown:
            'Echo 看似簡單,卻是所有「指令控制」的起點:把 if (input.length() > 0) 換成' +
            '判斷特定指令,就能做出文字遙控器,例如:\n\n' +
            '```cpp\n' +
            'if (input == "on")  digitalWrite(2, HIGH);\n' +
            'if (input == "off") digitalWrite(2, LOW);\n' +
            '```\n\n' +
            '打字 on 燈亮、off 燈滅——這正是這一課挑戰要你做的事。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '把 echo 改成「序列埠遙控燈」:輸入 on 點亮 GPIO2 的內建 LED,輸入 off 熄滅,' +
        '其他文字則回覆「Unknown command」。\n\n' +
        '提示:記得在 setup() 加 pinMode(2, OUTPUT)。' +
        '卡住可以問 AI 助教:「String 怎麼比較是否等於某個字?」',
      quiz: [
        {
          id: 'q1',
          question: '如果程式用 Serial.begin(115200),但監控視窗選 9600 鮑率,會怎樣?',
          options: [
            '完全正常',
            '看到亂碼或看不到訊息',
            'ESP32 會當機',
            '速度變慢但內容正確',
          ],
          answer: 1,
          explanation: '鮑率是雙方約定的通訊速度,不一致時資料會被解讀成亂碼。',
        },
        {
          id: 'q2',
          question: 'Serial.available() 的作用是?',
          options: [
            '檢查序列埠線有沒有接好',
            '回傳接收緩衝區裡有多少資料可讀',
            '清空螢幕',
            '設定鮑率',
          ],
          answer: 1,
          explanation: 'available() 回傳等待讀取的位元組數,大於 0 才需要去讀。',
        },
        {
          id: 'q3',
          question: 'input.trim() 做的事情是?',
          options: [
            '把文字全部變大寫',
            '刪除字串頭尾的空白與換行字元',
            '把字串反過來',
            '把字串變成數字',
          ],
          answer: 1,
          explanation: 'trim() 去除頭尾空白字元,讓後續的比對(如 input == "on")不會因多餘換行失敗。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'pwm-rgb',
      title: 'LEDC PWM 與 RGB 燈',
      minutes: 15,
      exampleId: 'esp32-pwm-led-rgb',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 認識 ESP32 專屬的 LEDC PWM 硬體與 ledcAttach() / ledcWrite() 寫法\n' +
            '- 了解 RGB LED 的三色混光原理\n' +
            '- 看懂範例如何用 HSV 色相環做出彩虹漸變',
        },
        {
          heading: '原理解說',
          markdown:
            'ESP32 沒有 Uno 的 analogWrite(),取而代之的是更強大的 **LEDC**(LED Control)硬體:' +
            '有 16 個獨立 PWM 通道,頻率和解析度都能自訂,原本就是為了控制 LED 而設計的。\n\n' +
            '**RGB LED** 其實是紅、綠、藍三顆小 LED 包在同一顆裡。' +
            '調整三色各自的亮度就能混出任何顏色——跟螢幕上每個像素的原理一模一樣:\n\n' +
            '- 紅 255 + 綠 0 + 藍 0 → 紅色\n' +
            '- 紅 255 + 綠 255 + 藍 0 → 黃色\n' +
            '- 紅 255 + 綠 255 + 藍 255 → 白色\n\n' +
            '生活比喻:三支手電筒(紅綠藍)照在同一面白牆上,各自調亮度,牆上的光就變色。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例把 RGB 三腳各接一個 LEDC 通道(節錄):\n\n' +
            '```cpp\n' +
            '#define R_PIN 16\n' +
            '#define G_PIN 17\n' +
            '#define B_PIN 18\n' +
            '\n' +
            'void setup() {\n' +
            '  ledcAttach(R_PIN, 5000, 8);\n' +
            '  ledcAttach(G_PIN, 5000, 8);\n' +
            '  ledcAttach(B_PIN, 5000, 8);\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  for (int h = 0; h < 360; h += 5) {\n' +
            '    float r, g, b;\n' +
            '    // HSV 轉 RGB(略)……\n' +
            '    ledcWrite(R_PIN, (int)(r * 255));\n' +
            '    ledcWrite(G_PIN, (int)(g * 255));\n' +
            '    ledcWrite(B_PIN, (int)(b * 255));\n' +
            '    delay(30);\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            '- **ledcAttach(接腳, 頻率, 解析度)**:把接腳接上 LEDC。範例用 5000Hz、8 位元' +
            '(8 位元 = 0~255,跟 analogWrite 一樣的範圍)。\n' +
            '- **ledcWrite(接腳, 值)**:輸出工作週期 0~255。\n' +
            '- 範例讓色相 h 從 0° 繞到 360°(HSV 色相環),再換算成 RGB——' +
            '所以燈會像彩虹一樣連續變色。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路,三色各串一顆 220Ω 電阻:\n\n' +
            '| ESP32 接腳 | 經過 | RGB LED 接腳 |\n' +
            '| --- | --- | --- |\n' +
            '| GPIO16 | 220Ω 電阻 | R(紅) |\n' +
            '| GPIO17 | 220Ω 電阻 | G(綠) |\n' +
            '| GPIO18 | 220Ω 電阻 | B(藍) |\n' +
            '| GND | — | COM(共同腳) |\n\n' +
            '這顆是**共陰極** RGB LED:共同腳接 GND,三支色腳給高電位就亮。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 把 delay(30) 改成 delay(5),彩虹轉速變快;改成 100 則變成慢慢呼吸的漸層。\n' +
        '2. 不用 HSV,自己在 loop() 裡用 ledcWrite 依序做出「紅 → 綠 → 藍」三色輪播,每色停 1 秒。\n\n' +
        '想懂 HSV 的數學?問 AI 助教:「HSV 色相環轉 RGB 的原理是什麼?」',
      quiz: [
        {
          id: 'q1',
          question: 'ESP32 上做 PWM 輸出,範例使用的函式是?',
          options: [
            'analogWrite()',
            'ledcAttach() + ledcWrite()',
            'digitalWrite()',
            'pwmBegin()',
          ],
          answer: 1,
          explanation: 'ESP32 用 LEDC 硬體做 PWM:ledcAttach 設定接腳,ledcWrite 輸出工作週期。',
        },
        {
          id: 'q2',
          question: 'ledcAttach(R_PIN, 5000, 8) 中的 8 代表什麼?',
          options: [
            '接腳編號 8',
            'PWM 解析度 8 位元(數值 0~255)',
            '同時控制 8 顆 LED',
            '延遲 8 毫秒',
          ],
          answer: 1,
          explanation: '第三個參數是解析度位元數,8 位元代表工作週期可分成 0~255 共 256 階。',
        },
        {
          id: 'q3',
          question: '想讓共陰極 RGB LED 顯示「黃色」,三色亮度應該接近?',
          options: [
            '紅 255、綠 0、藍 0',
            '紅 255、綠 255、藍 0',
            '紅 0、綠 0、藍 255',
            '紅 0、綠 255、藍 255',
          ],
          answer: 1,
          explanation: '紅光加綠光混合出黃色,藍色保持熄滅。',
        },
        {
          id: 'q4',
          question: '範例中 RGB LED 的 COM 腳接到哪裡?',
          options: ['GPIO2', '3V3', 'GND', 'GPIO19'],
          answer: 2,
          explanation: '範例用共陰極 RGB LED,共同腳(COM)接 GND,各色腳給 PWM 高電位發光。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'dht11',
      title: '物聯網感測:DHT11',
      minutes: 15,
      exampleId: 'esp32-dht11',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 在 ESP32 上讀取 DHT11 溫濕度(GPIO4、3.3V 供電)\n' +
            '- 學會 Serial.printf() 的格式化輸出\n' +
            '- 用感測器面板即時改變溫濕度,理解「感測資料」是物聯網的起點',
        },
        {
          heading: '原理解說',
          markdown:
            '物聯網(IoT)的第一步永遠是**感測**:沒有資料,連網就沒有意義。' +
            '這一課把 Arduino 課學過的 DHT11 搬到 ESP32 上,重點在「換板子要改什麼」:\n\n' +
            '| 項目 | Uno 版 | ESP32 版 |\n' +
            '| --- | --- | --- |\n' +
            '| 資料腳 | 接腳 7 | **GPIO4** |\n' +
            '| 供電 | 5V | **3V3**(3.3V) |\n' +
            '| 鮑率 | 9600 | **115200** |\n' +
            '| 程式邏輯 | 相同 | 相同 |\n\n' +
            'DHT11 本身支援 3.3V~5.5V 供電,所以接 ESP32 的 3V3 完全沒問題。' +
            '讀取邏輯(begin、readHumidity、readTemperature、isnan 檢查)一行都不用改——' +
            '這就是 Arduino 生態系函式庫「跨板通用」的威力。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例程式碼(資料腳接 GPIO4):\n\n' +
            '```cpp\n' +
            '#include <DHT.h>\n' +
            '\n' +
            '#define DHT_PIN  4    // GPIO 4\n' +
            '#define DHT_TYPE DHT11\n' +
            '\n' +
            'DHT dht(DHT_PIN, DHT_TYPE);\n' +
            '\n' +
            'void setup() {\n' +
            '  Serial.begin(115200);\n' +
            '  dht.begin();\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  delay(2000);  // DHT11 兩次讀取要間隔 1 秒以上\n' +
            '\n' +
            '  float h = dht.readHumidity();\n' +
            '  float t = dht.readTemperature();\n' +
            '\n' +
            '  if (isnan(h) || isnan(t)) {\n' +
            '    Serial.println("DHT11: waiting for sensor...");\n' +
            '    return;\n' +
            '  }\n' +
            '  Serial.printf("Temp: %.0f C   Humidity: %.0f %%\\n", t, h);\n' +
            '}\n' +
            '```\n\n' +
            '- **Serial.printf()**:ESP32 支援 C 語言風格的格式化輸出,' +
            '%.0f 表示「小數 0 位的浮點數」,一行就能排好版——比一連串 Serial.print 簡潔。\n' +
            '- 其餘結構(物件建立、isnan 防呆)與 Uno 版完全相同。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路:\n\n' +
            '| DHT11 接腳 | 接到 ESP32 | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| VCC | 3V3 | 3.3V 電源 |\n' +
            '| GND | GND | 接地 |\n' +
            '| SDA(資料) | GPIO4 | 溫濕度資料線 |\n\n' +
            '執行後打開序列埠監控視窗(115200),點擊畫布上的 DHT11 打開面板,' +
            '拖動滑桿(預設 24°C / 66%)就能看到讀值即時改變。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '做「舒適度指標」:溫度 20~26°C 且濕度 40~70% 時印出「Comfortable」,' +
        '否則印出「Uncomfortable」。用感測器面板拉不同數值驗證邏輯。\n\n' +
        '提示:if 條件可以用 && 串起來。也可以問 AI 助教:「printf 的 %.1f 是什麼意思?」',
      quiz: [
        {
          id: 'q1',
          question: '把 DHT11 從 Uno 換到 ESP32,下列哪件事「不需要」改?',
          options: [
            '資料腳的編號',
            '供電電壓(5V 改 3.3V)',
            'readTemperature() 的呼叫方式',
            '序列埠鮑率',
          ],
          answer: 2,
          explanation: 'DHT 函式庫跨板通用,讀取函式完全相同;改的只有接腳、供電與鮑率習慣。',
        },
        {
          id: 'q2',
          question: '範例中 DHT11 的資料腳接在 ESP32 的哪支接腳?',
          options: ['GPIO2', 'GPIO4', 'GPIO16', 'GPIO18'],
          answer: 1,
          explanation: '範例定義 DHT_PIN 為 4,資料線接 GPIO4。',
        },
        {
          id: 'q3',
          question: 'Serial.printf("Temp: %.0f C", t) 中 %.0f 的意思是?',
          options: [
            '印出整數變數',
            '印出小數 0 位的浮點數',
            '印出 0 個字',
            '印出百分比符號',
          ],
          answer: 1,
          explanation: '%.0f 是浮點數格式,小數位取 0 位,例如 24.6 會印成 25。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'wifi',
      title: '連上 WiFi',
      minutes: 15,
      exampleId: 'esp32-wifi-connect',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 學會用 WiFi.begin() 與 WiFi.status() 連上無線網路\n' +
            '- 認識模擬器內建的虛擬熱點 Velxio-GUEST\n' +
            '- 理解 IP 位址、MAC 位址與訊號強度(RSSI)的意義',
        },
        {
          heading: '原理解說',
          markdown:
            '這一刻開始,你的開發板正式成為「物聯網裝置」!\n\n' +
            '連上 WiFi 之後會發生什麼事?路由器(無線基地台)會發給裝置一個 **IP 位址**——' +
            '相當於網路世界的「門牌號碼」,之後別人要找這塊板子,靠的就是這串數字(例如 10.0.2.15)。\n\n' +
            '幾個名詞:\n\n' +
            '- **SSID**:WiFi 熱點的名字。模擬器內建一個**虛擬熱點**,名字叫 **Velxio-GUEST**,' +
            '開放式、不需要密碼。\n' +
            '- **MAC 位址**:網卡出廠時燒進去的唯一編號,像裝置的身分證字號。\n' +
            '- **RSSI**:訊號強度,單位 dBm,越接近 0 訊號越好(-50 很強、-90 很弱)。\n\n' +
            '生活比喻:SSID 是店名,連上後拿到的 IP 是你的座位號碼,MAC 則是你的身分證。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例連線流程(節錄):\n\n' +
            '```cpp\n' +
            '#include <WiFi.h>\n' +
            '\n' +
            'const char* ssid = "Velxio-GUEST";\n' +
            '\n' +
            'void setup() {\n' +
            '  Serial.begin(115200);\n' +
            '  WiFi.begin(ssid, "", 6);  // 頻道 6、無密碼\n' +
            '\n' +
            '  while (WiFi.status() != WL_CONNECTED) {\n' +
            '    delay(500);\n' +
            '    Serial.print(".");\n' +
            '  }\n' +
            '\n' +
            '  Serial.println(" Connected!");\n' +
            '  Serial.printf("IP Address: %s\\n", WiFi.localIP().toString().c_str());\n' +
            '  Serial.printf("MAC Address: %s\\n", WiFi.macAddress().c_str());\n' +
            '  Serial.printf("Signal Strength (RSSI): %d dBm\\n", WiFi.RSSI());\n' +
            '}\n' +
            '```\n\n' +
            '- **WiFi.begin(ssid, 密碼, 頻道)**:發起連線。虛擬熱點沒有密碼,傳空字串;' +
            '指定頻道 6 可以加快模擬器裡的連線速度。\n' +
            '- **while (WiFi.status() != WL_CONNECTED)**:連線需要時間,' +
            '用 while 迴圈每 0.5 秒檢查一次,還沒連上就印一個點。\n' +
            '- **WiFi.localIP()**:連上後拿到的 IP 位址,下一課的網頁伺服器就靠它。\n\n' +
            '範例的 loop() 還會每 5 秒檢查一次連線狀態,斷線就自動重連——實務上的好習慣。',
        },
        {
          heading: '操作與觀察',
          markdown:
            '本課不需要接線,執行後觀察序列埠監控視窗(115200):\n\n' +
            '1. 先看到一排點點 ......(連線中)。\n' +
            '2. 接著出現 Connected! 與三行資訊:IP、MAC、RSSI。\n' +
            '3. 把 IP 位址抄下來——這是你的板子在網路上的門牌。\n\n' +
            '想一想:如果 SSID 打錯字(例如打成 Velxio-GUES),程式會發生什麼事?' +
            '(答案:while 迴圈永遠等不到 WL_CONNECTED,點點會一直印下去。)',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 故意把 ssid 改成不存在的名字,執行並觀察「連不上」長什麼樣子,再改回來。\n' +
        '2. 在 setup() 的最後加上一行,把 WiFi.RSSI() 的值跟 -70 比較:大於 -70 印「Good signal」,' +
        '否則印「Weak signal」。\n\n' +
        '可以問 AI 助教:「IP 位址和 MAC 位址差在哪?」',
      quiz: [
        {
          id: 'q1',
          question: '模擬器內建虛擬 WiFi 熱點的 SSID 是?',
          options: ['ESP32-AP', 'Velxio-GUEST', 'Home-WiFi', 'IoT-Lab'],
          answer: 1,
          explanation: '模擬器提供名為 Velxio-GUEST 的開放式熱點,不需要密碼即可連線。',
        },
        {
          id: 'q2',
          question: '裝置連上 WiFi 後拿到的「IP 位址」的作用像什麼?',
          options: [
            '裝置的出廠序號',
            '網路世界的門牌號碼,讓別人找得到這台裝置',
            'WiFi 的密碼',
            '訊號強度',
          ],
          answer: 1,
          explanation: 'IP 位址是路由器分配的網路位址,其他裝置靠它找到並連線這塊板子。',
        },
        {
          id: 'q3',
          question: 'while (WiFi.status() != WL_CONNECTED) 這個迴圈在做什麼?',
          options: [
            '重新啟動 WiFi 晶片',
            '反覆等待、直到連線成功才往下執行',
            '掃描附近所有熱點',
            '設定 IP 位址',
          ],
          answer: 1,
          explanation: '連線需要時間,迴圈每 0.5 秒檢查狀態,成功(WL_CONNECTED)才離開。',
        },
        {
          id: 'q4',
          question: 'RSSI 值 -50 dBm 和 -90 dBm,哪個訊號比較好?',
          options: ['-90 dBm', '-50 dBm', '一樣好', 'RSSI 跟訊號無關'],
          answer: 1,
          explanation: 'RSSI 越接近 0 訊號越強,-50 比 -90 強很多。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'webserver',
      title: 'HTTP 網頁伺服器',
      minutes: 20,
      exampleId: 'esp32-http-server',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 用 WebServer 函式庫在 ESP32 上架一個網頁伺服器\n' +
            '- 理解 HTTP GET 請求與「路由(route)」的概念\n' +
            '- 從瀏覽器打開 ESP32 提供的網頁,看到即時的開發板資訊',
        },
        {
          heading: '原理解說',
          markdown:
            '你每天上網做的事:瀏覽器送出 **HTTP GET 請求** →' +
            ' 伺服器回傳 HTML → 瀏覽器畫出網頁。\n\n' +
            '這一課的主角換人:**ESP32 自己當伺服器**!' +
            '手機、電腦連到它的 IP 位址,它就回傳一頁自己組出來的 HTML。' +
            '智慧家電的設定頁面就是這樣做的。\n\n' +
            '兩個核心概念:\n\n' +
            '- **路由(route)**:「網址路徑 → 處理函式」的對照表。' +
            '訪問 / 執行 handleRoot,訪問 /api/hello 回傳 JSON——像餐廳菜單,點什麼菜上什麼菜。\n' +
            '- **handleClient()**:loop() 裡不停呼叫它,等於伺服器的服務生一直在門口看有沒有新客人。\n\n' +
            '模擬器提醒:模擬的 ESP32 在伺服器端的虛擬網路裡,瀏覽器無法直接連它的 IP,' +
            '要透過平台提供的 **IoT Gateway 連結**開啟網頁。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例架構(節錄):\n\n' +
            '```cpp\n' +
            '#include <WiFi.h>\n' +
            '#include <WebServer.h>\n' +
            '\n' +
            'const char* ssid = "Velxio-GUEST";\n' +
            'WebServer server(80);\n' +
            '\n' +
            'void handleRoot() {\n' +
            '  String html = "<!DOCTYPE html><html>...";\n' +
            '  html += "<h1>Hello from ESP32!</h1>";\n' +
            '  html += "<p>Uptime: " + String(millis() / 1000) + "s</p>";\n' +
            '  server.send(200, "text/html", html);\n' +
            '}\n' +
            '\n' +
            'void setup() {\n' +
            '  // ...連上 WiFi(同上一課)...\n' +
            '  server.on("/", handleRoot);\n' +
            '  server.on("/api/hello", []() {\n' +
            '    server.send(200, "application/json",\n' +
            '                "{\\"message\\":\\"Hello from ESP32!\\"}");\n' +
            '  });\n' +
            '  server.begin();\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  server.handleClient();\n' +
            '}\n' +
            '```\n\n' +
            '- **WebServer server(80)**:在 80 埠(HTTP 標準埠)開店。\n' +
            '- **server.on("/", handleRoot)**:註冊路由——根路徑交給 handleRoot 處理。\n' +
            '- **server.send(200, 類型, 內容)**:回應請求。200 是「成功」的 HTTP 狀態碼;' +
            '類型可以是 text/html(網頁)或 application/json(資料)。\n' +
            '- 網頁內容是**動態組出來的**:每次重新整理,Uptime 秒數都會更新。',
        },
        {
          heading: '操作與觀察',
          markdown:
            '1. 執行範例,序列埠會印出 Server started at: http://(IP)/ 。\n' +
            '2. 點擊平台顯示的 **IoT Gateway 連結**,瀏覽器會打開 ESP32 的網頁,' +
            '看到「Hello from ESP32!」與請求次數、運行秒數、剩餘記憶體。\n' +
            '3. 按幾次重新整理,觀察 Requests served 一直增加——每次整理都是一個新的 GET 請求。\n' +
            '4. 把網址尾端改成 /api/hello,會看到 JSON 格式的回應——' +
            '這就是手機 App 跟裝置交換資料的常見形式。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '在 handleRoot 的 HTML 裡加一行你的班級或姓名,重新執行並重新整理網頁看看變化。\n\n' +
        '進階:新增一條路由 /led/on,在處理函式中點亮 GPIO2 的內建 LED 並回覆「LED is ON」;' +
        '再做 /led/off——你就完成了一個「網頁遙控燈」!' +
        '可以問 AI 助教:「server.on 的處理函式裡怎麼控制接腳?」',
      quiz: [
        {
          id: 'q1',
          question: 'WebServer server(80) 中的 80 是什麼?',
          options: [
            '最多允許 80 人連線',
            'HTTP 服務的標準埠號',
            '記憶體大小 80KB',
            '網頁寬度 80 像素',
          ],
          answer: 1,
          explanation: '80 是 HTTP 的預設埠號,瀏覽器打網址時預設就連 80 埠。',
        },
        {
          id: 'q2',
          question: 'server.on("/", handleRoot) 的意思是?',
          options: [
            '每秒執行一次 handleRoot',
            '有人訪問根路徑「/」時,交給 handleRoot 函式處理',
            '把伺服器打開',
            '刪除首頁',
          ],
          answer: 1,
          explanation: 'server.on 註冊「路徑 → 處理函式」的路由對應,像菜單上的一道菜。',
        },
        {
          id: 'q3',
          question: '為什麼 loop() 裡要一直呼叫 server.handleClient()?',
          options: [
            '讓 WiFi 不斷線',
            '不斷檢查並處理新進來的 HTTP 請求',
            '更新網頁上的時間',
            '清除記憶體',
          ],
          answer: 1,
          explanation: 'handleClient() 每次呼叫都會檢查有沒有新請求並執行對應路由,不呼叫就沒人接客。',
        },
        {
          id: 'q4',
          question: 'HTTP 回應狀態碼 200 代表?',
          options: ['找不到頁面', '伺服器錯誤', '請求成功', '需要密碼'],
          answer: 2,
          explanation: '200 OK 表示請求處理成功;404 才是找不到、500 是伺服器錯誤。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'mqtt',
      title: 'MQTT 把資料送上雲',
      minutes: 20,
      exampleId: 'esp32-wifi-mqtt',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 理解 MQTT 的發佈/訂閱(publish/subscribe)模型與 broker 的角色\n' +
            '- 學會用 PubSubClient 函式庫連上公開 broker 並收發訊息\n' +
            '- 建立完整的物聯網架構觀:感測器 → 網路 → 雲端 → 手機',
        },
        {
          heading: '原理解說',
          markdown:
            '上一課的網頁伺服器要「別人主動來問」;物聯網更常見的需求是裝置**主動回報**,' +
            '這就是 **MQTT** 登場的時候——專為小裝置設計的輕量傳訊協定。\n\n' +
            'MQTT 的三個角色:\n\n' +
            '- **Broker(訊息中心)**:雲端的「郵局」,所有訊息都經過它轉發。範例用公開的' +
            ' broker.hivemq.com(埠 1883)。\n' +
            '- **發佈者(publisher)**:把訊息投到某個**主題(topic)**,像把信投進指定信箱。\n' +
            '- **訂閱者(subscriber)**:訂閱某主題,一有新訊息 broker 就立刻送來。\n\n' +
            '生活比喻:訂閱 YouTube 頻道——頻道主(發佈者)上傳影片到頻道(主題),' +
            '平台(broker)通知所有訂閱者。發佈者和訂閱者**互相不用認識**,只要約好主題名稱。\n\n' +
            '完整的物聯網資料旅程:\n\n' +
            '```\n' +
            '感測器(DHT11) → ESP32 → WiFi → MQTT Broker(雲端) → 手機/電腦 App\n' +
            '```',
        },
        {
          heading: '程式重點',
          markdown:
            '範例很巧妙:**自己發佈、自己訂閱同一個主題**,訊息繞雲端一圈回來,' +
            '每收到一次就切換 GPIO2 的 LED——不需要任何外部工具就能驗證整條路是通的。節錄:\n\n' +
            '```cpp\n' +
            '#include <WiFi.h>\n' +
            '#include <PubSubClient.h>\n' +
            '\n' +
            'const char* WIFI_SSID   = "Velxio-GUEST";\n' +
            'const char* MQTT_BROKER = "broker.hivemq.com";\n' +
            'const int   MQTT_PORT   = 1883;\n' +
            '\n' +
            'WiFiClient net;\n' +
            'PubSubClient mqtt(net);\n' +
            '\n' +
            'void onMessage(char* t, byte* payload, unsigned int len) {\n' +
            '  // 收到訊息:印出內容並切換 LED\n' +
            '  digitalWrite(LED, !digitalRead(LED));\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  if (!mqtt.connected()) connectMQTT();\n' +
            '  mqtt.loop();\n' +
            '  if (millis() - lastPub > 2000) {\n' +
            '    lastPub = millis();\n' +
            '    String msg = "hello " + String(counter++);\n' +
            '    mqtt.publish(topic.c_str(), msg.c_str());\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            '- **PubSubClient mqtt(net)**:MQTT 客戶端,底層用 WiFi 的 TCP 連線。\n' +
            '- **setCallback(onMessage)** + **subscribe(主題)**:訂閱後,broker 一轉發訊息就呼叫 onMessage。\n' +
            '- **publish(主題, 內容)**:每 2 秒發佈一則 "hello N"。\n' +
            '- **mqtt.loop()**:跟 handleClient() 一樣要在 loop() 裡持續呼叫,負責收發與保持連線。\n' +
            '- 範例用晶片序號組出**獨一無二的主題**(velxio/demo/xxxx),' +
            '避免跟別人的訊息混在一起——公開 broker 大家共用,主題就是彼此的頻道名。',
        },
        {
          heading: '操作與觀察',
          markdown:
            '執行後打開序列埠監控視窗(115200),依序會看到:\n\n' +
            '1. WiFi: joining Velxio-GUEST ... 連上虛擬熱點。\n' +
            '2. MQTT: connecting to broker.hivemq.com ... 連上雲端 broker。\n' +
            '3. Subscribed to velxio/demo/xxxx 訂閱自己的主題。\n' +
            '4. 之後每 2 秒一組 TX(發佈)與 RX(收到)訊息成對出現——' +
            '每一則訊息都真的**繞到雲端再回來**!\n\n' +
            '想一想:如果第二塊 ESP32 訂閱同一個主題,它也會收到訊息——' +
            '這就是裝置之間互傳資料的方法,也是智慧家庭的基礎。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 把發佈間隔從 2000 毫秒改成 5000,觀察 TX/RX 的節奏變化。\n' +
        '2. 把發佈內容從 "hello N" 改成模擬的溫度值,例如 "temp:25"。\n' +
        '3. 進階:結合 DHT11 課——把真的 dht.readTemperature() 讀值發佈上雲,' +
        '你就完成了一個貨真價實的物聯網溫度回報器!\n\n' +
        '可以問 AI 助教:「怎麼把 float 溫度值變成 MQTT 要的字串?」',
      quiz: [
        {
          id: 'q1',
          question: 'MQTT 架構中,broker 的角色是?',
          options: [
            '產生感測資料',
            '集中接收並轉發所有訊息的中間站',
            '提供 WiFi 訊號',
            '編譯程式碼',
          ],
          answer: 1,
          explanation: 'broker 像郵局:發佈者把訊息交給它,由它轉發給所有訂閱該主題的裝置。',
        },
        {
          id: 'q2',
          question: 'MQTT 的「主題(topic)」的作用是?',
          options: [
            '訊息的分類頻道,發佈與訂閱靠它對上',
            '訊息的密碼',
            'broker 的網址',
            '裝置的 IP 位址',
          ],
          answer: 0,
          explanation: '發佈者投到某主題、訂閱者訂閱同一主題,雙方不需認識也能交換訊息。',
        },
        {
          id: 'q3',
          question: '範例為什麼要「發佈並訂閱同一個主題」?',
          options: [
            '因為 broker 規定要這樣',
            '讓訊息繞經雲端回到自己,不用外部工具就能驗證整條鏈路',
            '為了加密訊息',
            '為了省電',
          ],
          answer: 1,
          explanation: '自己訂自己的主題,收到 RX 就證明 WiFi、DNS、broker 全都正常運作。',
        },
        {
          id: 'q4',
          question: '和上一課的網頁伺服器相比,MQTT 更適合哪種情境?',
          options: [
            '顯示漂亮的網頁畫面',
            '裝置主動、持續地回報小量資料給雲端',
            '傳送大型影片檔',
            '取代 WiFi 連線',
          ],
          answer: 1,
          explanation: 'MQTT 輕量、由裝置主動發佈,適合感測器定期上報;網頁伺服器則要等人來查詢。',
        },
      ],
    },
  ],
};
