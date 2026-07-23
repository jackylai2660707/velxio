/**
 * 「AI物聯網實驗室」課程一:Arduino 入門
 *
 * 內容以 src/data/examples.ts 中的真實範例為基礎,
 * 每一課的 exampleId 都對應「開啟電路範例」按鈕載入的專案。
 * lesson id 是進度記錄的永久鍵值,發布後不可更改。
 */
import type { Course } from './types';

export const arduinoBasicsCourse: Course = {
  id: 'arduino-basics',
  title: 'Arduino 入門',
  description:
    '從零開始學 Arduino:點亮 LED、讀取按鈕與感測器、控制伺服馬達,最後做出自己的紅綠燈與點陣圖案。全部在瀏覽器中模擬,不需要真實硬體。',
  level: '入門',
  emoji: '🔌',
  lessons: [
    // ─────────────────────────────────────────────────────────────
    {
      id: 'intro',
      title: '認識 Arduino 與線上實驗室',
      minutes: 15,
      exampleId: 'blink-led',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 認識 Arduino Uno 開發板與它的接腳配置\n' +
            '- 了解本平台的四大區域:程式編輯器、電路畫布、執行按鈕、序列埠監控視窗\n' +
            '- 看懂 Arduino 程式的兩大骨架:setup() 與 loop()',
        },
        {
          heading: '原理解說',
          markdown:
            'Arduino Uno 是一塊「微控制器開發板」,你可以把它想成一顆**很小很專心的電腦**:' +
            '它沒有螢幕、沒有鍵盤,但很擅長一件事——依照你寫的程式,控制電子零件。\n\n' +
            'Uno 板上最重要的接腳有三類:\n\n' +
            '| 接腳 | 數量 | 用途 |\n' +
            '| --- | --- | --- |\n' +
            '| 數位接腳 0~13 | 14 支 | 輸出/讀取「高電位(HIGH)」或「低電位(LOW)」 |\n' +
            '| 類比接腳 A0~A5 | 6 支 | 讀取連續變化的電壓(例如旋鈕、光線) |\n' +
            '| 5V / 3.3V / GND | 數支 | 供電用。GND 是「接地」,所有電路的共同回路 |\n\n' +
            '其中**接腳 13** 特別:板子上已經內建一顆 LED 接在上面,所以不接任何零件也能做出會閃的燈,' +
            '這正是我們的第一個範例。',
        },
        {
          heading: '程式重點',
          markdown:
            '打開範例後,你會在編輯器看到這段程式碼(接腳 13 就是內建 LED):\n\n' +
            '```cpp\n' +
            'void setup() {\n' +
            '  pinMode(13, OUTPUT);\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  digitalWrite(13, HIGH);\n' +
            '  delay(1000);\n' +
            '  digitalWrite(13, LOW);\n' +
            '  delay(1000);\n' +
            '}\n' +
            '```\n\n' +
            '每個 Arduino 程式一定有兩個函式:\n\n' +
            '- **setup()**:通電後只執行**一次**,用來做初始設定,例如告訴板子「接腳 13 要當輸出用」。\n' +
            '- **loop()**:setup() 結束後**不停重複執行**,像跑操場一圈又一圈——這就是「迴圈」名稱的由來。\n\n' +
            '生活比喻:setup() 像早上出門前的準備(穿鞋、背書包只做一次),loop() 像上課的日常作息表(每天重複)。',
        },
        {
          heading: '平台操作',
          markdown:
            '照著以下步驟跑一次:\n\n' +
            '1. 按「開啟電路範例」載入 Blink LED 專案。\n' +
            '2. 左邊是**程式編輯器**,右邊是**電路畫布**(可以看到 Arduino Uno 板)。\n' +
            '3. 按上方的**編譯/執行**按鈕,程式會送到伺服器編譯成韌體,再載入模擬器執行。\n' +
            '4. 觀察板子上接腳 13 旁的內建 LED,每一秒亮、每一秒暗。\n' +
            '5. 之後的課程會用到**序列埠監控視窗**(Serial Monitor)——它是開發板跟你「講話」的地方。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '把兩個 delay(1000) 都改成 delay(200),重新執行,看看 LED 閃爍的速度有什麼變化。' +
        '再試試把其中一個改成 delay(2000),觀察「亮的時間」和「暗的時間」分別由哪一行控制。\n\n' +
        '卡住了嗎?隨時可以問右邊的 AI 助教,例如:「delay 的單位是什麼?」',
      quiz: [
        {
          id: 'q1',
          question: 'Arduino 程式裡的 loop() 函式會執行幾次?',
          options: ['只執行一次', '執行兩次', '不停重複執行', '要看 setup() 裡怎麼設定'],
          answer: 2,
          explanation: 'loop() 在 setup() 結束後會被不斷重複呼叫,直到斷電或停止模擬。',
        },
        {
          id: 'q2',
          question: 'Arduino Uno 的哪一支接腳內建了一顆 LED?',
          options: ['接腳 0', '接腳 7', '接腳 13', 'A0'],
          answer: 2,
          explanation: 'Uno 板上有一顆 LED 直接接在接腳 13,所以不外接零件也能做閃爍實驗。',
        },
        {
          id: 'q3',
          question: '想讀取「連續變化」的訊號(例如旋鈕轉多少),應該用哪一類接腳?',
          options: ['數位接腳 0~13', '類比接腳 A0~A5', 'GND 接腳', '5V 接腳'],
          answer: 1,
          explanation: 'A0~A5 是類比輸入接腳,可以讀出 0V 到 5V 之間連續變化的電壓。',
        },
        {
          id: 'q4',
          question: 'GND 接腳的作用是什麼?',
          options: ['提供 5V 電源', '當作電路的共同回路(接地)', '傳送序列埠資料', '產生時脈訊號'],
          answer: 1,
          explanation: '電流要形成迴路才會流動,GND(接地)就是所有零件共用的回流路徑。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'blink',
      title: '點亮你的第一顆 LED',
      minutes: 15,
      exampleId: 'blink-led',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 學會 pinMode()、digitalWrite()、delay() 三個基本函式\n' +
            '- 了解 LED 的極性:陽極(A)與陰極(C)不能接反\n' +
            '- 知道為什麼 LED 需要串聯一顆 220Ω 的限流電阻',
        },
        {
          heading: '原理解說',
          markdown:
            'LED(發光二極體)是一種**只允許電流單向通過**的零件:\n\n' +
            '- **陽極(Anode,A)**:長腳,接電源正極方向。\n' +
            '- **陰極(Cathode,C)**:短腳,接 GND 方向。\n\n' +
            '接反了 LED 不會壞,但也不會亮——就像單行道,方向錯了車子過不去。\n\n' +
            '**為什麼要限流電阻?** LED 本身幾乎不限制電流,直接接 5V 會讓過大的電流把它燒掉。' +
            '串一顆 220Ω 電阻後,電流大約是 (5V − 2V) ÷ 220Ω ≈ 14mA,安全又夠亮。' +
            '比喻:電阻像水管上的閥門,把水流(電流)限制在安全範圍。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例完整程式碼只有短短幾行:\n\n' +
            '```cpp\n' +
            'void setup() {\n' +
            '  pinMode(13, OUTPUT);   // 接腳 13 設定為輸出\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  digitalWrite(13, HIGH); // 輸出 5V,LED 亮\n' +
            '  delay(1000);            // 等 1000 毫秒(1 秒)\n' +
            '  digitalWrite(13, LOW);  // 輸出 0V,LED 暗\n' +
            '  delay(1000);\n' +
            '}\n' +
            '```\n\n' +
            '三個函式各司其職:\n\n' +
            '- **pinMode(接腳, 模式)**:宣告接腳要當輸入(INPUT)還是輸出(OUTPUT),通常寫在 setup()。\n' +
            '- **digitalWrite(接腳, 電位)**:輸出 HIGH(5V)或 LOW(0V)。\n' +
            '- **delay(毫秒)**:讓程式「暫停」指定的毫秒數。1000 毫秒 = 1 秒。',
        },
        {
          heading: '接線說明',
          markdown:
            '本範例使用接腳 13 的**內建 LED**,所以畫布上不需要外接零件。' +
            '若要外接一顆 LED,正確接法是:\n\n' +
            '| 起點 | 終點 | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| Uno 接腳 13 | 電阻 220Ω 一端 | 訊號先過限流電阻 |\n' +
            '| 電阻另一端 | LED 陽極(A) | 電流流入 LED |\n' +
            '| LED 陰極(C) | Uno GND | 完成迴路 |\n\n' +
            '之後的課程範例都會看到這種「接腳 → 電阻 → LED → GND」的標準接法。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 讓 LED 用「亮 0.1 秒、暗 0.9 秒」的節奏閃爍,像心跳指示燈。\n' +
        '2. 進階:用多組 digitalWrite + delay 打出「短短長」的節奏(像摩斯密碼)。\n\n' +
        '提示:亮多久由 HIGH 之後的 delay 決定。可以問 AI 助教:「怎麼做出摩斯密碼的 SOS?」',
      quiz: [
        {
          id: 'q1',
          question: 'digitalWrite(13, HIGH) 的意思是什麼?',
          options: [
            '把接腳 13 設成輸入模式',
            '讓接腳 13 輸出高電位(5V)',
            '讀取接腳 13 的電位',
            '把接腳 13 關閉',
          ],
          answer: 1,
          explanation: 'digitalWrite 負責輸出電位,HIGH 代表輸出 5V 高電位。',
        },
        {
          id: 'q2',
          question: 'LED 要串聯 220Ω 電阻的主要原因是?',
          options: [
            '讓 LED 更亮',
            '限制電流、避免 LED 燒毀',
            '改變 LED 的顏色',
            '加快 LED 的反應速度',
          ],
          answer: 1,
          explanation: 'LED 幾乎不限流,若不串電阻,過大的電流會讓它過熱燒毀。',
        },
        {
          id: 'q3',
          question: 'LED 接反(陽極接 GND、陰極接訊號)會發生什麼事?',
          options: ['會爆炸', '不會亮,因為電流無法單向通過', '會變得更亮', '顏色會改變'],
          answer: 1,
          explanation: 'LED 是二極體,只允許電流從陽極流向陰極,接反時電流不通、燈不亮。',
        },
        {
          id: 'q4',
          question: 'delay(500) 會讓程式暫停多久?',
          options: ['500 秒', '5 秒', '0.5 秒', '50 秒'],
          answer: 2,
          explanation: 'delay 的單位是毫秒,500 毫秒等於 0.5 秒。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'button',
      title: '按鈕輸入與上拉電阻',
      minutes: 15,
      exampleId: 'button-led',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 學會用 digitalRead() 讀取按鈕狀態\n' +
            '- 了解 INPUT_PULLUP(內建上拉電阻)的用途,以及為什麼「按下是 LOW」\n' +
            '- 認識按鈕的機械彈跳(bounce)現象',
        },
        {
          heading: '原理解說',
          markdown:
            '按鈕沒被按時,輸入接腳如果什麼都不接,電位會「飄浮」不定——一下 HIGH 一下 LOW,程式讀到的值不可靠。\n\n' +
            '解法是**上拉電阻**:用一顆電阻把接腳輕輕「拉」到 5V,平常穩定讀到 HIGH;' +
            '按下按鈕後,接腳被直接接到 GND,讀到 LOW。Arduino 貼心地把這顆電阻**內建**在晶片裡,' +
            '寫 pinMode(接腳, INPUT_PULLUP) 就能啟用,不必自己接。\n\n' +
            '所以邏輯剛好相反:**沒按 = HIGH,按下 = LOW**。\n\n' +
            '**彈跳(bounce)**:實體按鈕的金屬片接觸的瞬間會快速彈跳好幾次,' +
            '造成一次按壓被讀成好幾次。簡單的解法是按下後 delay 一小段時間再讀,稱為「消除彈跳(debounce)」。' +
            '本課範例是直接控制 LED 亮滅,彈跳影響不大;若要做「按一下切換一次」就必須處理。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例程式碼(按鈕接在接腳 2,LED 接在接腳 13):\n\n' +
            '```cpp\n' +
            'const int BUTTON_PIN = 2;\n' +
            'const int LED_PIN = 13;\n' +
            '\n' +
            'void setup() {\n' +
            '  pinMode(BUTTON_PIN, INPUT_PULLUP);\n' +
            '  pinMode(LED_PIN, OUTPUT);\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  int buttonState = digitalRead(BUTTON_PIN);\n' +
            '\n' +
            '  if (buttonState == LOW) {\n' +
            '    digitalWrite(LED_PIN, HIGH);\n' +
            '  } else {\n' +
            '    digitalWrite(LED_PIN, LOW);\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            '- **digitalRead(接腳)** 回傳目前電位(HIGH 或 LOW),存到變數 buttonState。\n' +
            '- 因為用了 INPUT_PULLUP,判斷式寫的是 buttonState == LOW ——**LOW 才代表按下**。\n' +
            '- 注意這裡沒有 delay:loop() 每秒跑好幾萬次,按鈕一按 LED 幾乎立刻反應。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路:\n\n' +
            '| 起點 | 終點 | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| Uno 接腳 2 | 按鈕一側 | 訊號腳 |\n' +
            '| 按鈕另一側 | Uno GND | 按下時把接腳 2 拉到 LOW |\n' +
            '| Uno 接腳 13 | 電阻 220Ω → LED 陽極(A) | LED 輸出 |\n' +
            '| LED 陰極(C) | Uno GND | 完成迴路 |\n\n' +
            '執行後,用滑鼠按住畫布上的按鈕,LED 會亮;放開就暗。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '把邏輯改成「按下時 LED **熄滅**、放開時亮」(把 if 判斷反過來)。\n\n' +
        '進階挑戰:做「切換開關」——按一下亮、再按一下暗。這需要一個變數記住目前狀態,' +
        '而且會遇到彈跳問題。試著自己寫,寫不出來就問 AI 助教:「怎麼做按鈕切換並消除彈跳?」',
      quiz: [
        {
          id: 'q1',
          question: '使用 INPUT_PULLUP 時,按鈕「按下」瞬間 digitalRead 會讀到什麼?',
          options: ['HIGH', 'LOW', '0.5V', '不一定'],
          answer: 1,
          explanation: '按下時接腳被直接接到 GND,所以讀到 LOW;沒按時被上拉電阻拉到 HIGH。',
        },
        {
          id: 'q2',
          question: '如果輸入接腳什麼都不接,也不啟用上拉電阻,會發生什麼事?',
          options: [
            '固定讀到 HIGH',
            '固定讀到 LOW',
            '電位飄浮不定,讀值不可靠',
            'Arduino 會當機',
          ],
          answer: 2,
          explanation: '沒有明確電位來源的接腳會受雜訊影響,讀到的值忽高忽低。',
        },
        {
          id: 'q3',
          question: '按鈕的「彈跳(bounce)」指的是什麼?',
          options: [
            '按鈕會從板子上彈起來',
            '按下瞬間金屬接點快速抖動,造成多次觸發',
            'LED 會閃爍',
            '程式會自動重新啟動',
          ],
          answer: 1,
          explanation: '機械接點閉合瞬間會彈跳數毫秒,讓一次按壓被程式讀成好幾次。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'pwm',
      title: 'PWM 與呼吸燈',
      minutes: 15,
      exampleId: 'fade-led',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 了解 PWM(脈寬調變)如何用數位訊號模擬「中間亮度」\n' +
            '- 學會 analogWrite() 與 0~255 的亮度範圍\n' +
            '- 知道 Uno 哪些接腳支援 PWM,並用變數做出漸變效果',
        },
        {
          heading: '原理解說',
          markdown:
            '數位接腳只有 HIGH 和 LOW 兩種狀態,那要怎麼讓 LED「半亮」?\n\n' +
            '答案是 **PWM(Pulse Width Modulation,脈寬調變)**:讓接腳以極快的速度開開關關,' +
            '快到人眼看不出來在閃,只感覺到「平均亮度」。一個週期裡 HIGH 所佔的比例稱為' +
            '**工作週期(duty cycle,也叫佔空比)**:\n\n' +
            '- 工作週期 100% → 全亮(相當於 analogWrite 值 255)\n' +
            '- 工作週期 50% → 半亮(值約 127)\n' +
            '- 工作週期 0% → 全暗(值 0)\n\n' +
            '生活比喻:超快速地開關電風扇的開關,開的時間比例越高,平均風量越大。\n\n' +
            'Uno 只有 **3、5、6、9、10、11** 這六支接腳支援 PWM(板子上會標示「~」符號),' +
            '本範例用的正是接腳 9。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例用兩個變數做出「呼吸燈」漸亮漸暗:\n\n' +
            '```cpp\n' +
            'const int LED_PIN = 9; // PWM 接腳\n' +
            '\n' +
            'int brightness = 0;\n' +
            'int fadeAmount = 5;\n' +
            '\n' +
            'void loop() {\n' +
            '  analogWrite(LED_PIN, brightness);\n' +
            '\n' +
            '  brightness += fadeAmount;\n' +
            '\n' +
            '  if (brightness <= 0 || brightness >= 255) {\n' +
            '    fadeAmount = -fadeAmount;\n' +
            '  }\n' +
            '\n' +
            '  delay(30);\n' +
            '}\n' +
            '```\n\n' +
            '- **analogWrite(接腳, 值)**:值的範圍是 0~255,對應工作週期 0%~100%。\n' +
            '- 每圈 loop 把 brightness 加 5;碰到 0 或 255 時把 fadeAmount **變號**,方向反轉——' +
            '就像球碰到牆壁反彈。\n' +
            '- delay(30) 控制漸變速度:值越小,呼吸越快。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路(藍色 LED):\n\n' +
            '| 起點 | 終點 | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| Uno 接腳 9 | 電阻 220Ω 一端 | PWM 訊號輸出 |\n' +
            '| 電阻另一端 | LED 陽極(A) | 限流後進入 LED |\n' +
            '| LED 陰極(C) | Uno GND | 完成迴路 |',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 把 fadeAmount 從 5 改成 15,或把 delay(30) 改成 delay(5),觀察呼吸速度的變化。\n' +
        '2. 讓亮度只在 50~200 之間來回(修改 if 的邊界值),LED 就永遠不會全暗或全亮。\n\n' +
        '可以問 AI 助教:「為什麼 analogWrite 的最大值是 255?」',
      quiz: [
        {
          id: 'q1',
          question: 'PWM 讓 LED 看起來「半亮」的原理是?',
          options: [
            '把輸出電壓降到 2.5V',
            '快速切換 HIGH/LOW,用平均亮度騙過人眼',
            '換一顆比較暗的 LED',
            '降低 CPU 的執行速度',
          ],
          answer: 1,
          explanation: 'PWM 仍然只輸出 HIGH/LOW,靠極快的切換讓人眼感覺到中間亮度。',
        },
        {
          id: 'q2',
          question: 'analogWrite(9, 127) 大約對應多少工作週期?',
          options: ['約 12%', '約 50%', '約 90%', '100%'],
          answer: 1,
          explanation: '127 約是 255 的一半,對應約 50% 的工作週期,也就是半亮。',
        },
        {
          id: 'q3',
          question: '下列哪一支 Uno 接腳「不」支援 PWM?',
          options: ['接腳 3', '接腳 9', '接腳 11', '接腳 13'],
          answer: 3,
          explanation: 'Uno 的 PWM 接腳是 3、5、6、9、10、11;接腳 13 沒有 PWM 功能。',
        },
        {
          id: 'q4',
          question: '範例中 fadeAmount = -fadeAmount 這行的作用是?',
          options: [
            '把亮度歸零',
            '讓亮度變化的方向反轉(漸亮變漸暗)',
            '關閉 PWM',
            '讓程式停止',
          ],
          answer: 1,
          explanation: '變號後每圈迴圈改為減 5,亮度從漸亮轉為漸暗,形成呼吸效果。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'analog',
      title: '類比輸入:可變電阻',
      minutes: 15,
      exampleId: 'uno-potentiometer',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 學會用 analogRead() 讀取 0~1023 的類比數值\n' +
            '- 了解 10 位元 ADC 與可變電阻的分壓原理\n' +
            '- 學會把讀值換算成電壓與百分比,並認識 map() 函式',
        },
        {
          heading: '原理解說',
          markdown:
            '**可變電阻(電位計)**有三支接腳:兩端接 5V 和 GND,中間那支(SIG)的電壓' +
            '會隨旋鈕位置在 0V~5V 之間滑動——這就是**分壓原理**,像把一條 5V 的「電壓尺」' +
            '用旋鈕挑出其中一點。\n\n' +
            'Arduino 的 **ADC(類比數位轉換器)**是 10 位元,把 0V~5V 切成 2 的 10 次方 = **1024 格**,' +
            '所以 analogRead() 回傳 **0~1023**:\n\n' +
            '- 0V → 0\n' +
            '- 2.5V → 約 512\n' +
            '- 5V → 1023\n\n' +
            '生活比喻:ADC 像一把有 1024 個刻度的尺,把「連續」的電壓量成「一格一格」的數字。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例把讀值換算成電壓和百分比,印到序列埠監控視窗:\n\n' +
            '```cpp\n' +
            'const int POT_PIN = A0;\n' +
            '\n' +
            'void loop() {\n' +
            '  int raw = analogRead(POT_PIN);          // 0~1023\n' +
            '  float voltage = raw * (5.0 / 1023.0);   // 換算成伏特\n' +
            '  float percent = raw / 10.23;            // 換算成百分比\n' +
            '\n' +
            '  Serial.print("ADC: ");\n' +
            '  Serial.print(raw);\n' +
            '  Serial.print("  |  ");\n' +
            '  Serial.print(voltage, 2);\n' +
            '  Serial.println(" V");\n' +
            '  delay(200);\n' +
            '}\n' +
            '```\n\n' +
            '- **analogRead(A0)** 回傳 0~1023 的整數。\n' +
            '- 乘上 5.0/1023.0 就換算回實際電壓;除以 10.23 得到 0~100 的百分比。\n' +
            '- 另一個常用工具是 **map(值, 0, 1023, 0, 255)**:把一個範圍的數字等比例換到另一個範圍,' +
            '例如把旋鈕讀值變成 PWM 亮度。\n\n' +
            '執行後打開序列埠監控視窗,轉動畫布上的旋鈕,數字會即時變化。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路:\n\n' +
            '| 可變電阻接腳 | 接到 Uno | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| VCC | 5V | 電壓尺的上端 |\n' +
            '| GND | GND | 電壓尺的下端 |\n' +
            '| SIG(中間腳) | A0 | 分壓後的訊號,送進 ADC |',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '結合上一課:在畫布加一顆 LED 接到接腳 9,用 map(raw, 0, 1023, 0, 255) 把旋鈕讀值' +
        '轉成 analogWrite 的亮度——做出「旋鈕調光燈」。\n\n' +
        '提示:記得 pinMode 和 220Ω 電阻。接線不確定時,問 AI 助教:「怎麼把可變電阻讀值變成 LED 亮度?」',
      quiz: [
        {
          id: 'q1',
          question: 'analogRead() 在 Uno 上回傳的數值範圍是?',
          options: ['0~255', '0~1023', '0~4095', '0~100'],
          answer: 1,
          explanation: 'Uno 的 ADC 是 10 位元,2 的 10 次方 = 1024 格,所以範圍是 0~1023。',
        },
        {
          id: 'q2',
          question: '接腳 A0 讀到 512 左右,代表輸入電壓大約是?',
          options: ['0.5V', '1V', '2.5V', '5V'],
          answer: 2,
          explanation: '512 約是 1023 的一半,對應 5V 的一半,約 2.5V。',
        },
        {
          id: 'q3',
          question: '可變電阻的中間腳(SIG)輸出的電壓由什麼決定?',
          options: [
            '旋鈕的位置(分壓比例)',
            '電源的頻率',
            'Arduino 的程式碼',
            '接線的顏色',
          ],
          answer: 0,
          explanation: '旋鈕位置改變兩段電阻的比例,中間腳依分壓原理輸出對應的電壓。',
        },
        {
          id: 'q4',
          question: 'map(x, 0, 1023, 0, 255) 的用途是?',
          options: [
            '畫出一張地圖',
            '把 0~1023 的數值等比例換算到 0~255',
            '把數值四捨五入',
            '把類比接腳變成數位接腳',
          ],
          answer: 1,
          explanation: 'map() 做線性比例換算,常用來把 ADC 讀值轉成 PWM 輸出範圍。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'traffic',
      title: '專題:紅綠燈',
      minutes: 20,
      exampleId: 'traffic-light',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 同時控制多顆 LED,並理解「狀態依序切換」的寫法\n' +
            '- 練習把生活需求(紅綠燈)拆解成程式步驟\n' +
            '- 熟悉用常數(const int)為接腳取名字的好習慣',
        },
        {
          heading: '原理解說',
          markdown:
            '寫專題的第一步不是打程式,而是**把需求拆成步驟**。紅綠燈的運作可以寫成一張流程表:\n\n' +
            '| 順序 | 狀態 | 持續時間 |\n' +
            '| --- | --- | --- |\n' +
            '| 1 | 紅燈亮 | 3 秒 |\n' +
            '| 2 | 黃燈亮 | 1 秒 |\n' +
            '| 3 | 綠燈亮 | 3 秒 |\n' +
            '| 4 | 黃燈亮 | 1 秒 |\n' +
            '| 回到 1 | — | — |\n\n' +
            '每個狀態都是同一個模式:**點亮 → 等待 → 熄滅**。而 loop() 天生就會無限重複,' +
            '正好對應紅綠燈「跑完一輪再從頭」的特性——不需要額外寫「回到步驟 1」。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例用三個常數為接腳取名,程式立刻變得好讀:\n\n' +
            '```cpp\n' +
            'const int RED_PIN = 13;\n' +
            'const int YELLOW_PIN = 12;\n' +
            'const int GREEN_PIN = 11;\n' +
            '\n' +
            'void loop() {\n' +
            '  // 紅燈\n' +
            '  digitalWrite(RED_PIN, HIGH);\n' +
            '  delay(3000);\n' +
            '  digitalWrite(RED_PIN, LOW);\n' +
            '\n' +
            '  // 黃燈\n' +
            '  digitalWrite(YELLOW_PIN, HIGH);\n' +
            '  delay(1000);\n' +
            '  digitalWrite(YELLOW_PIN, LOW);\n' +
            '\n' +
            '  // 綠燈\n' +
            '  digitalWrite(GREEN_PIN, HIGH);\n' +
            '  delay(3000);\n' +
            '  digitalWrite(GREEN_PIN, LOW);\n' +
            '  // ... 之後還有一次黃燈,然後回到紅燈\n' +
            '}\n' +
            '```\n\n' +
            '- 用 **const int** 取名的好處:要換接腳只需改一行,而且 RED_PIN 比 13 好懂太多。\n' +
            '- 每個狀態三行(亮、等、滅)整齊排列,一眼就能對照上面的流程表。',
        },
        {
          heading: '接線說明',
          markdown:
            '三顆 LED、各配一顆 220Ω 限流電阻:\n\n' +
            '| Uno 接腳 | 經過 | LED | 陰極接到 |\n' +
            '| --- | --- | --- | --- |\n' +
            '| 13 | 220Ω 電阻 | 紅色 LED 陽極(A) | GND |\n' +
            '| 12 | 220Ω 電阻 | 黃色 LED 陽極(A) | GND |\n' +
            '| 11 | 220Ω 電阻 | 綠色 LED 陽極(A) | GND |\n\n' +
            '三顆 LED 的陰極(C)都回到 GND——GND 是大家共用的回路。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 台灣的紅綠燈綠燈結束前會**閃爍**幾下才轉黃燈。用一個 for 迴圈讓綠燈快閃 3 次' +
        '(亮 0.25 秒、暗 0.25 秒)再進黃燈。\n' +
        '2. 進階:加一顆按鈕當「行人按鈕」,按下後下一輪紅燈延長為 6 秒。\n\n' +
        '不知道 for 迴圈怎麼寫?問 AI 助教:「給我一個讓 LED 閃 3 次的 for 迴圈範例」。',
      quiz: [
        {
          id: 'q1',
          question: '範例中紅、黃、綠三顆 LED 分別接在哪些接腳?',
          options: ['13、12、11', '1、2、3', '9、10、11', 'A0、A1、A2'],
          answer: 0,
          explanation: '範例定義 RED_PIN = 13、YELLOW_PIN = 12、GREEN_PIN = 11。',
        },
        {
          id: 'q2',
          question: '用 const int RED_PIN = 13 取代直接寫 13 的最大好處是?',
          options: [
            '程式執行比較快',
            '程式好讀、要換接腳只需改一行',
            '可以省電',
            'LED 會比較亮',
          ],
          answer: 1,
          explanation: '有意義的名字讓程式易讀,接腳改變時也只要修改宣告那一行。',
        },
        {
          id: 'q3',
          question: '紅綠燈「跑完一輪自動從頭開始」是靠什麼達成的?',
          options: [
            '程式最後有 goto 指令',
            'loop() 本身就會不斷重複執行',
            'delay() 會重新啟動程式',
            '需要按重置鍵',
          ],
          answer: 1,
          explanation: 'loop() 執行到結尾後會自動再從頭執行,天生適合週期性的流程。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'servo',
      title: '伺服馬達',
      minutes: 15,
      exampleId: 'uno-servo',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 認識伺服馬達:可以精準轉到指定角度(0°~180°)的馬達\n' +
            '- 學會使用 Servo 函式庫的 attach() 與 write()\n' +
            '- 了解伺服馬達背後的 PWM 脈寬控制原理',
        },
        {
          heading: '原理解說',
          markdown:
            '一般馬達通電就一直轉,**伺服馬達**卻能「轉到指定角度就停住」,' +
            '常用在機器手臂、遙控車的轉向機構。\n\n' +
            '它聽的是一種特別的 PWM 訊號:每 20 毫秒收到一個脈波,**脈波的寬度**決定角度——\n\n' +
            '- 脈寬約 1.0 毫秒 → 轉到 0°\n' +
            '- 脈寬約 1.5 毫秒 → 轉到 90°\n' +
            '- 脈寬約 2.0 毫秒 → 轉到 180°\n\n' +
            '生活比喻:像用口哨聲的「長短」下指令,短哨向左、長哨向右。' +
            '幸好這些脈波不用自己產生,Arduino 內建的 **Servo 函式庫**會幫我們處理,' +
            '我們只要說「轉到幾度」就好。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例讓伺服馬達在 0°~180° 之間來回掃動:\n\n' +
            '```cpp\n' +
            '#include <Servo.h>\n' +
            '\n' +
            '#define SERVO_PIN 9\n' +
            '\n' +
            'Servo myServo;\n' +
            '\n' +
            'void setup() {\n' +
            '  myServo.attach(SERVO_PIN);\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  // 0 → 180 度掃過去\n' +
            '  for (int angle = 0; angle <= 180; angle += 2) {\n' +
            '    myServo.write(angle);\n' +
            '    delay(15);\n' +
            '  }\n' +
            '  // 180 → 0 度掃回來\n' +
            '  for (int angle = 180; angle >= 0; angle -= 2) {\n' +
            '    myServo.write(angle);\n' +
            '    delay(15);\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            '- **#include <Servo.h>**:載入內建的 Servo 函式庫,不需另外安裝。\n' +
            '- **attach(9)**:告訴函式庫馬達的訊號線接在接腳 9。\n' +
            '- **write(角度)**:直接指定 0~180 的角度,函式庫自動換算成對應脈寬。\n' +
            '- for 迴圈每次加 2 度、停 15 毫秒,讓轉動看起來平滑。',
        },
        {
          heading: '接線說明',
          markdown:
            '伺服馬達有三條線,依照範例接法:\n\n' +
            '| 伺服馬達接腳 | 接到 Uno | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| V+(紅線) | 5V | 電源 |\n' +
            '| GND(棕/黑線) | GND | 接地 |\n' +
            '| PWM(橘/黃線) | 接腳 9 | 角度控制訊號 |\n\n' +
            '註:真實電路中若接多顆伺服馬達,要用外部電源供電,別讓 Uno 的 5V 過載。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '1. 讓馬達只在 45°~135° 之間掃動(改 for 迴圈的起訖值)。\n' +
        '2. 把每步的 delay(15) 改成 delay(2),觀察轉速變化。\n' +
        '3. 進階:結合可變電阻——旋鈕轉多少,馬達就轉到對應角度(提示:map(raw, 0, 1023, 0, 180))。\n\n' +
        '可以問 AI 助教:「幫我把可變電阻和伺服馬達接在一起」。',
      quiz: [
        {
          id: 'q1',
          question: '伺服馬達與一般直流馬達最大的差別是?',
          options: [
            '伺服馬達比較大顆',
            '伺服馬達可以精準轉到指定角度並停住',
            '伺服馬達不需要電源',
            '伺服馬達只能連續旋轉',
          ],
          answer: 1,
          explanation: '伺服馬達內建控制電路,依訊號脈寬精準定位角度,一般馬達只會持續旋轉。',
        },
        {
          id: 'q2',
          question: 'myServo.write(90) 的意思是?',
          options: [
            '讓馬達轉 90 圈',
            '讓馬達轉到 90 度的位置',
            '設定馬達速度為 90%',
            '暫停 90 毫秒',
          ],
          answer: 1,
          explanation: 'Servo 函式庫的 write() 參數是目標角度(0~180 度)。',
        },
        {
          id: 'q3',
          question: '伺服馬達判斷要轉到哪個角度,依據的是訊號的什麼?',
          options: ['電壓高低', '脈波的寬度(脈寬)', '電流大小', '線的顏色'],
          answer: 1,
          explanation: '每 20 毫秒一次的脈波中,脈寬約 1~2 毫秒對應 0~180 度。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'ultrasonic',
      title: '超音波測距',
      minutes: 20,
      exampleId: 'uno-hcsr04',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 了解 HC-SR04 超音波感測器的 Trig / Echo 運作流程\n' +
            '- 學會用 pulseIn() 量測脈波時間\n' +
            '- 會用「聲速 × 時間 ÷ 2」把時間換算成距離,並用 if 做門檻判斷',
        },
        {
          heading: '原理解說',
          markdown:
            'HC-SR04 的測距原理跟**蝙蝠**一樣:發出人耳聽不到的超音波,聽回音、算時間。\n\n' +
            '流程分四步:\n\n' +
            '1. Arduino 對 **TRIG 腳**送出一個 10 微秒的觸發脈波。\n' +
            '2. 感測器發出 8 個 40kHz 的超音波脈衝。\n' +
            '3. 聲波撞到物體反彈回來,**ECHO 腳**輸出一段高電位,長度 = 聲波來回的時間。\n' +
            '4. Arduino 量這段時間,換算成距離。\n\n' +
            '**換算公式**:聲速約每微秒 0.0343 公分,而量到的時間是「去程 + 回程」,所以要除以 2:\n\n' +
            '距離(公分)= 時間(微秒)× 0.0343 ÷ 2',
        },
        {
          heading: '程式重點',
          markdown:
            '範例把量測包成一個函式 measureCm():\n\n' +
            '```cpp\n' +
            '#define TRIG_PIN 9\n' +
            '#define ECHO_PIN 10\n' +
            '\n' +
            'long measureCm() {\n' +
            '  // 送出 10 微秒的觸發脈波\n' +
            '  digitalWrite(TRIG_PIN, LOW);\n' +
            '  delayMicroseconds(2);\n' +
            '  digitalWrite(TRIG_PIN, HIGH);\n' +
            '  delayMicroseconds(10);\n' +
            '  digitalWrite(TRIG_PIN, LOW);\n' +
            '  // 量 ECHO 高電位的時間(30 毫秒逾時,約 5 公尺)\n' +
            '  long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);\n' +
            '  return (duration == 0) ? -1 : (long)(duration * 0.0343 / 2.0);\n' +
            '}\n' +
            '```\n\n' +
            '- **delayMicroseconds(10)**:以「微秒」為單位的暫停,比 delay() 精細一千倍。\n' +
            '- **pulseIn(接腳, HIGH, 逾時)**:等待接腳變 HIGH 並回傳持續的微秒數;' +
            '超過逾時(30000 微秒)就回傳 0,代表太遠沒回音。\n' +
            '- 回傳 -1 代表「超出範圍」,主程式用 if (cm < 0) 判斷後印出不同訊息——' +
            '這就是**門檻判斷**的基本形。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路:\n\n' +
            '| HC-SR04 接腳 | 接到 Uno | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| VCC | 5V | 電源 |\n' +
            '| GND | GND | 接地 |\n' +
            '| TRIG | 接腳 9 | 觸發輸出(Arduino → 感測器) |\n' +
            '| ECHO | 接腳 10 | 回音輸入(感測器 → Arduino) |\n\n' +
            '執行後打開序列埠監控視窗,再**點擊畫布上的感測器**調整模擬距離(預設 30 公分),' +
            '觀察數值變化。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '做一個「倒車雷達」:距離小於 10 公分時,在序列埠印出「WARNING!」,' +
        '否則照常印距離。(提示:在 loop() 加一個 if (cm < 10) 判斷。)\n\n' +
        '進階:加一顆 LED,距離越近閃越快。可以問 AI 助教:「怎麼讓 LED 閃爍速度跟距離成反比?」',
      quiz: [
        {
          id: 'q1',
          question: 'HC-SR04 的 ECHO 腳輸出的高電位時間代表什麼?',
          options: [
            '感測器的溫度',
            '超音波「去程加回程」所花的時間',
            '電池剩餘電量',
            '物體的大小',
          ],
          answer: 1,
          explanation: 'ECHO 的高電位長度等於聲波從發出到反彈回來的總時間,所以換算距離時要除以 2。',
        },
        {
          id: 'q2',
          question: '距離公式要「除以 2」的原因是?',
          options: [
            '聲速只有一半',
            '量到的時間包含去程和回程',
            '感測器有兩個喇叭',
            '單位換算需要',
          ],
          answer: 1,
          explanation: '聲波是打到物體再反彈回來,走了兩倍距離,所以時間要除以 2。',
        },
        {
          id: 'q3',
          question: 'pulseIn(ECHO_PIN, HIGH, 30000UL) 中 30000 的作用是?',
          options: [
            '設定聲速',
            '逾時上限:等太久就回傳 0,避免程式卡住',
            '設定音量',
            '重複量測 30000 次',
          ],
          answer: 1,
          explanation: '若物體太遠沒有回音,pulseIn 在 30000 微秒後放棄並回傳 0。',
        },
        {
          id: 'q4',
          question: 'delayMicroseconds(10) 暫停的時間是?',
          options: ['10 秒', '10 毫秒', '10 微秒', '0.1 秒'],
          answer: 2,
          explanation: 'delayMicroseconds 以微秒(百萬分之一秒)為單位,比 delay 的毫秒精細一千倍。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'dht11',
      title: '溫濕度感測 DHT11',
      minutes: 15,
      exampleId: 'uno-dht11-serial',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 學會安裝並使用 DHT 感測器函式庫\n' +
            '- 用 readTemperature() / readHumidity() 讀取溫濕度並印到序列埠\n' +
            '- 學會在模擬器的感測器面板即時調整數值,觀察程式反應',
        },
        {
          heading: '原理解說',
          markdown:
            'DHT11 是入門最常見的**溫濕度感測器**,一顆同時量兩種數據。' +
            '它不像可變電阻輸出「電壓」,而是透過**單一資料線**用數位訊號把量好的數字傳給 Arduino,' +
            '通訊協定有點複雜——幸好有人寫好了**函式庫**幫我們處理。\n\n' +
            '函式庫就像「別人寫好、包裝完整的工具箱」:我們不用懂 DHT11 的通訊細節,' +
            '呼叫 readTemperature() 就拿到攝氏溫度。\n\n' +
            '注意兩個特性:\n\n' +
            '- DHT11 每次量測之間需要**至少 1 秒**的間隔,讀太快會失敗。\n' +
            '- 讀取可能失敗(回傳 NaN,「不是數字」),程式要用 isnan() 檢查。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例程式碼(資料腳接在接腳 7):\n\n' +
            '```cpp\n' +
            '#include <DHT.h>\n' +
            '\n' +
            '#define DHT_PIN  7\n' +
            '#define DHT_TYPE DHT11\n' +
            '\n' +
            'DHT dht(DHT_PIN, DHT_TYPE);\n' +
            '\n' +
            'void setup() {\n' +
            '  Serial.begin(9600);\n' +
            '  dht.begin();\n' +
            '}\n' +
            '\n' +
            'void loop() {\n' +
            '  delay(2000);  // DHT11 兩次讀取要間隔 1 秒以上\n' +
            '  float humidity = dht.readHumidity();\n' +
            '  float tempC    = dht.readTemperature();\n' +
            '\n' +
            '  if (isnan(humidity) || isnan(tempC)) {\n' +
            '    Serial.println("ERROR: Failed to read from DHT11!");\n' +
            '    return;\n' +
            '  }\n' +
            '  Serial.print("Temperature: ");\n' +
            '  Serial.print(tempC, 0);\n' +
            '  Serial.println(" C");\n' +
            '}\n' +
            '```\n\n' +
            '- **DHT dht(DHT_PIN, DHT_TYPE)**:建立感測器物件,指定接腳和型號。\n' +
            '- **isnan() 檢查**:讀取失敗時直接 return,跳過這一輪,避免印出錯誤數字。\n' +
            '- 本範例需要「DHT sensor library」——真實開發中要先用**函式庫管理員**安裝,' +
            '範例已幫你設定好。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路:\n\n' +
            '| DHT11 接腳 | 接到 Uno | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| VCC | 5V | 電源 |\n' +
            '| GND | GND | 接地 |\n' +
            '| SDA(資料) | 接腳 7 | 溫濕度數位資料線 |\n\n' +
            '執行後打開序列埠監控視窗,再**點擊畫布上的 DHT11**打開感測器面板,' +
            '拖動溫度與濕度滑桿(預設 25°C / 60%),下一次讀取就會顯示新數值。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '做一個「高溫警報」:溫度超過 30°C 時印出「Too hot!」。' +
        '改好後在感測器面板把溫度拉到 35°C 測試有沒有觸發。\n\n' +
        '進階:同時判斷濕度大於 80% 印出「Too humid!」。' +
        '可以問 AI 助教:「if 裡怎麼同時判斷兩個條件?」',
      quiz: [
        {
          id: 'q1',
          question: '為什麼範例的 loop() 一開始要 delay(2000)?',
          options: [
            '讓 LED 有時間亮起來',
            'DHT11 兩次量測之間需要至少 1 秒的間隔',
            '節省電力',
            '等待 WiFi 連線',
          ],
          answer: 1,
          explanation: 'DHT11 量測速度慢,讀取間隔太短會拿不到有效資料。',
        },
        {
          id: 'q2',
          question: 'isnan(tempC) 為 true 代表什麼?',
          options: [
            '溫度太高',
            '這次讀取失敗,拿到的不是有效數字',
            '溫度是負的',
            '感測器過熱',
          ],
          answer: 1,
          explanation: 'NaN 是「Not a Number」,代表感測器通訊失敗,程式應該跳過這筆資料。',
        },
        {
          id: 'q3',
          question: '使用「函式庫」的主要好處是?',
          options: [
            '程式一定跑得比較快',
            '不必自己實作複雜細節,直接呼叫寫好的函式',
            '可以不用接線',
            '編譯速度變快',
          ],
          answer: 1,
          explanation: '函式庫把 DHT11 的通訊協定包裝好,我們只要呼叫 readTemperature() 等函式。',
        },
      ],
    },
    // ─────────────────────────────────────────────────────────────
    {
      id: 'matrix',
      title: 'MAX7219 點陣顯示',
      minutes: 20,
      exampleId: 'uno-max7219-heart',
      sections: [
        {
          heading: '學習目標',
          markdown:
            '- 認識 MAX7219 驅動晶片與 8×8 LED 點陣\n' +
            '- 看懂用 byte 陣列表示的位圖:每個 bit 對應一顆燈\n' +
            '- 學會 LedControl 函式庫的 setRow()、setIntensity()、clearDisplay()',
        },
        {
          heading: '原理解說',
          markdown:
            '8×8 點陣有 64 顆 LED,如果每顆都拉一條線到 Arduino,接腳早就不夠用了。\n' +
            '**MAX7219** 是專門的驅動晶片,只要 **3 條訊號線**(DIN、CLK、CS)' +
            '就能控制整片 64 顆燈——Arduino 把「要顯示什麼」用序列方式傳給它,由它負責點燈。\n\n' +
            '**位圖(bitmap)的表示法**:一列 8 顆燈剛好對應一個 byte 的 8 個 bit,' +
            '1 = 亮、0 = 暗。範例的愛心圖案:\n\n' +
            '```\n' +
            'B00000000   ........\n' +
            'B01100110   .oo..oo.\n' +
            'B11111111   oooooooo\n' +
            'B11111111   oooooooo\n' +
            'B11111111   oooooooo\n' +
            'B01111110   .oooooo.\n' +
            'B00111100   ..oooo..\n' +
            'B00011000   ...oo...\n' +
            '```\n\n' +
            '把 1 塗黑、0 留白,一顆愛心就浮現了——像素畫就是這個原理。',
        },
        {
          heading: '程式重點',
          markdown:
            '範例用 LedControl 函式庫繪製並讓愛心閃爍:\n\n' +
            '```cpp\n' +
            '#include <LedControl.h>\n' +
            '\n' +
            '// LedControl(DIN, CLK, CS, 裝置數量)\n' +
            'LedControl lc = LedControl(12, 11, 10, 1);\n' +
            '\n' +
            'const byte HEART[8] = {\n' +
            '  B00000000, B01100110, B11111111, B11111111,\n' +
            '  B11111111, B01111110, B00111100, B00011000,\n' +
            '};\n' +
            '\n' +
            'void setup() {\n' +
            '  lc.shutdown(0, false);   // 喚醒(晶片預設省電休眠)\n' +
            '  lc.setIntensity(0, 8);   // 亮度 0~15\n' +
            '  lc.clearDisplay(0);\n' +
            '}\n' +
            '\n' +
            'void drawHeart() {\n' +
            '  for (int row = 0; row < 8; row++) {\n' +
            '    lc.setRow(0, row, HEART[row]);\n' +
            '  }\n' +
            '}\n' +
            '```\n\n' +
            '- **LedControl(12, 11, 10, 1)**:依序是 DIN、CLK、CS 三支接腳與串接的晶片數量。\n' +
            '- **shutdown(0, false)**:MAX7219 開機預設在省電模式,要先喚醒才會亮。\n' +
            '- **setRow(裝置, 列, 位圖)**:一次寫入一整列 8 顆燈;for 迴圈跑 8 列就畫完整張圖。\n' +
            '- loop() 裡「畫圖 → delay(600) → 清空 → delay(300)」,做出閃爍的愛心。',
        },
        {
          heading: '接線說明',
          markdown:
            '依照範例電路:\n\n' +
            '| MAX7219 模組接腳 | 接到 Uno | 說明 |\n' +
            '| --- | --- | --- |\n' +
            '| VCC | 5V | 電源 |\n' +
            '| GND | GND | 接地 |\n' +
            '| DIN | 接腳 12 | 資料輸入 |\n' +
            '| CLK | 接腳 11 | 時脈 |\n' +
            '| CS | 接腳 10 | 晶片選擇 |\n\n' +
            '只用 3 條訊號線就控制 64 顆燈,這就是驅動晶片的威力。',
        },
      ],
      challenge:
        '### 動手挑戰\n\n' +
        '設計你自己的 8×8 圖案!在方格紙(或心裡)畫一個 8×8 的圖,' +
        '把每一列翻成 B 開頭的二進位(亮 = 1、暗 = 0),取代 HEART 陣列的內容。' +
        '笑臉、字母、外星人都可以。\n\n' +
        '進階:準備兩張圖輪流顯示,做出兩格動畫。' +
        '可以請 AI 助教:「幫我把一個笑臉圖案轉成 byte 陣列」。',
      quiz: [
        {
          id: 'q1',
          question: 'MAX7219 晶片的主要功能是?',
          options: [
            '量測溫度',
            '只用少數訊號線就驅動大量 LED(如 8×8 點陣)',
            '放大聲音訊號',
            '提供 WiFi 連線',
          ],
          answer: 1,
          explanation: 'MAX7219 接手 64 顆 LED 的掃描點亮工作,Arduino 只需用 3 條線傳資料給它。',
        },
        {
          id: 'q2',
          question: '位圖 B00111100 這一列會亮幾顆燈?',
          options: ['2 顆', '4 顆', '6 顆', '8 顆'],
          answer: 1,
          explanation: 'B00111100 中有四個 1,對應中間 4 顆燈亮起。',
        },
        {
          id: 'q3',
          question: 'setup() 裡呼叫 lc.shutdown(0, false) 的目的是?',
          options: [
            '關閉顯示器',
            '把晶片從預設的省電休眠模式喚醒',
            '設定亮度',
            '清除畫面',
          ],
          answer: 1,
          explanation: 'MAX7219 上電時處於省電休眠狀態,shutdown(0, false) 把它喚醒才能顯示。',
        },
        {
          id: 'q4',
          question: '範例中 lc.setRow(0, row, HEART[row]) 一次控制多少顆燈?',
          options: ['1 顆', '一整列 8 顆', '一整面 64 顆', '2 顆'],
          answer: 1,
          explanation: 'setRow 用一個 byte(8 個 bit)一次設定一整列 8 顆 LED 的亮暗。',
        },
      ],
    },
  ],
};
