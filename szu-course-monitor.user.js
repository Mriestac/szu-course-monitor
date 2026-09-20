// ==UserScript==
// @name         深大指定教学班名额监控 + Server酱
// @namespace    szu-open-course-monitor
// @version      8.1
// @description  每5秒监控指定课程的指定教学班，有空位立即通过Server酱通知
// @updateURL    https://raw.githubusercontent.com/Mriestac/szu-course-monitor/main/szu-course-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/Mriestac/szu-course-monitor/main/szu-course-monitor.user.js
// @match        https://ehall.szu.edu.cn/yjsxkapp/*
// @match        https://ehall.szu.edu.cn/xsxkapp/*
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      sctapi.ftqq.com
// @connect      *.push.ft07.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const INTERVAL = 5000;
    const WAIT_AFTER_QUERY = 1000;
    const DUPLICATE_PUSH_INTERVAL = 10 * 60 * 1000;

    let activeCourseCode = '';
    let selectedClassKey = '';

    let lastCurrent = null;
    let lastCapacity = null;

    let lastResults = [];

    let queryCount = 0;
    let checking = false;

    let audioContext = null;

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    function visible(el) {
        if (!el) return false;

        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);

        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    }

    function nowText() {
        return new Date().toLocaleString();
    }

    function escapeHtml(text) {
        return String(text)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    // ============================================================
    // 面板
    // ============================================================

    const panel = document.createElement('div');

    panel.style.cssText = `
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: 390px;
        max-height: 75vh;
        overflow-y: auto;
        padding: 14px 16px;
        background: rgba(24,30,42,.97);
        color: white;
        z-index: 99999999;
        border-radius: 10px;
        box-shadow: 0 4px 18px rgba(0,0,0,.35);
        font-family: "Microsoft YaHei", sans-serif;
        font-size: 14px;
        line-height: 1.7;
    `;

    panel.innerHTML = `
        <div style="
            font-size:17px;
            font-weight:bold;
            margin-bottom:5px;
        ">
            深大指定教学班监控
        </div>

        <div id="szu-course">
            监控课程：等待填写
        </div>

        <div style="margin-top:5px;">
            监控教学班：

            <select id="szu-class-select"
                style="
                    padding:3px 6px;
                    min-width:100px;
                ">
                <option value="">
                    等待查询
                </option>
            </select>
        </div>

        <div id="szu-target"
             style="margin-top:5px;">
            当前目标：--
        </div>

        <div id="szu-status"
             style="
                 margin-top:5px;
                 color:#ffd166;
             ">
            请进入「已开课程查询」并填写课程号
        </div>

        <div id="szu-class-list"
             style="margin-top:8px;">
        </div>

        <hr style="
            border:none;
            border-top:1px solid rgba(255,255,255,.15);
            margin:10px 0;
        ">

        <div id="szu-time">
            上次查询：--
        </div>

        <div id="szu-count">
            查询次数：0
        </div>

        <div>
            查询间隔：5 秒
        </div>

        <hr style="
            border:none;
            border-top:1px solid rgba(255,255,255,.15);
            margin:10px 0;
        ">

        <div id="server-config">
            Server酱：检查中……
        </div>

        <div id="server-status"
             style="color:#aaa">
            上次推送：--
        </div>

        <div style="
            margin-top:8px;
            display:flex;
            gap:6px;
            flex-wrap:wrap;
        ">
            <button id="szu-now">
                立即查询
            </button>

            <button id="szu-test">
                测试声音
            </button>

            <button id="server-set">
                设置 SendKey
            </button>

            <button id="server-test">
                测试消息推送
            </button>
        </div>
    `;

    document.body.appendChild(panel);

    for (const button of panel.querySelectorAll('button')) {
        button.style.cssText =
            'padding:5px 9px;cursor:pointer;';
    }

    const courseEl =
        document.getElementById('szu-course');

    const classSelectEl =
        document.getElementById('szu-class-select');

    const targetEl =
        document.getElementById('szu-target');

    const statusEl =
        document.getElementById('szu-status');

    const classListEl =
        document.getElementById('szu-class-list');

    const timeEl =
        document.getElementById('szu-time');

    const countEl =
        document.getElementById('szu-count');

    const serverConfigEl =
        document.getElementById('server-config');

    const serverStatusEl =
        document.getElementById('server-status');

    // ============================================================
    // 页面
    // ============================================================

    function isOpenCoursePage() {
        return document.body.innerText.includes(
            '仅显示计划内课程'
        );
    }

    function findCourseInput() {
        return [
            ...document.querySelectorAll(
                'input[type="text"]'
            )
        ].find(el =>
            visible(el) &&
            !panel.contains(el)
        ) || null;
    }

    function getCourseCode() {
        const input = findCourseInput();

        return input
            ? input.value.trim()
            : '';
    }

    function findQueryButton() {
        const elements = [
            ...document.querySelectorAll(
                'button,input[type="button"],input[type="submit"],a'
            )
        ];

        return elements.find(el => {
            if (!visible(el)) return false;
            if (panel.contains(el)) return false;

            return (
                (el.innerText || el.value || '')
                    .trim() === '查询'
            );
        }) || null;
    }

    // ============================================================
    // 读取所有教学班
    // ============================================================

    function readCourseResults(courseCode) {
        const rows = [
            ...document.querySelectorAll('tr')
        ];

        const matchedRows =
            rows.filter(tr => {
                if (!visible(tr)) return false;

                const text =
                    tr.innerText || '';

                return (
                    text.includes(courseCode) &&
                    /(\d+)\s*\/\s*(\d+)/.test(text)
                );
            });

        if (!matchedRows.length) {
            throw new Error(
                `没有找到课程 ${courseCode}`
            );
        }

        return matchedRows.map(
            (row, index) => {

                const text =
                    row.innerText;

                const numberMatch =
                    text.match(
                        /(\d+)\s*\/\s*(\d+)/
                    );

                // 学校页面“容量”列的显示顺序是：容量 / 当前已选人数
                // 例如 250/100 表示容量 250、当前已选 100、剩余 150。
                const capacity =
                    Number(numberMatch[1]);

                const current =
                    Number(numberMatch[2]);

                const link =
                    row.querySelector('a');

                const fullName =
                    link
                        ? link.textContent.trim()
                        : `${courseCode}-教学班${index + 1}`;

                let classNo =
                    String(index + 1);

                const classMatch =
                    fullName.match(
                        /[（(]\s*([^()（）]+)\s*[）)]\s*$/
                    );

                if (classMatch) {
                    classNo =
                        classMatch[1].trim();
                }

                let courseName =
                    fullName;

                courseName =
                    courseName.replace(
                        new RegExp(
                            '^' +
                            courseCode.replace(
                                /[.*+?^${}()|[\]\\]/g,
                                '\\$&'
                            ) +
                            '\\s*[-—]?\\s*'
                        ),
                        ''
                    );

                courseName =
                    courseName.replace(
                        /\s*[（(][^()（）]+[）)]\s*$/,
                        ''
                    );

                const classKey =
                    classNo;

                return {
                    classKey,
                    courseCode,
                    courseName,
                    fullName,
                    classNo,
                    current,
                    capacity
                };
            }
        );
    }

    // ============================================================
    // 教学班选择
    // ============================================================

    function getSavedClass(courseCode) {
        return (
            GM_getValue(
                `TARGET_CLASS_${courseCode}`,
                ''
            ) || ''
        );
    }

    function saveSelectedClass(
        courseCode,
        classKey
    ) {
        GM_setValue(
            `TARGET_CLASS_${courseCode}`,
            classKey
        );
    }

    function updateClassSelector(results) {
        const oldValue =
            classSelectEl.value;

        classSelectEl.innerHTML = '';

        if (results.length === 1) {
            const item =
                results[0];

            const option =
                document.createElement('option');

            option.value =
                item.classKey;

            option.textContent =
                `${item.classNo}班`;

            classSelectEl.appendChild(
                option
            );

            classSelectEl.value =
                item.classKey;

            selectedClassKey =
                item.classKey;

            saveSelectedClass(
                activeCourseCode,
                item.classKey
            );

            return;
        }

        const empty =
            document.createElement('option');

        empty.value = '';

        empty.textContent =
            '请选择';

        classSelectEl.appendChild(
            empty
        );

        for (const item of results) {
            const option =
                document.createElement('option');

            option.value =
                item.classKey;

            option.textContent =
                `${item.classNo}班 ` +
                `(已选 ${item.current} / 容量 ${item.capacity})`;

            classSelectEl.appendChild(
                option
            );
        }

        const saved =
            getSavedClass(
                activeCourseCode
            );

        const candidate =
            results.find(
                item =>
                    item.classKey === oldValue
            )
            ? oldValue
            : (
                results.find(
                    item =>
                        item.classKey === saved
                )
                ? saved
                : ''
            );

        classSelectEl.value =
            candidate;

        selectedClassKey =
            candidate;
    }

    classSelectEl.addEventListener(
        'change',
        () => {

            selectedClassKey =
                classSelectEl.value;

            if (
                activeCourseCode &&
                selectedClassKey
            ) {
                saveSelectedClass(
                    activeCourseCode,
                    selectedClassKey
                );
            }

            lastCurrent = null;
            lastCapacity = null;

            const item =
                lastResults.find(
                    x =>
                        x.classKey ===
                        selectedClassKey
                );

            if (item) {
                targetEl.textContent =
                    `当前目标：${item.classNo}班 ` +
                    `已选 ${item.current} / 容量 ${item.capacity}`;

                statusEl.innerHTML =
                    '<span style="color:#66b3ff">' +
                    '已切换监控教学班，下一次查询开始建立状态' +
                    '</span>';
            }
        }
    );

    // ============================================================
    // 显示所有班，但只突出目标班
    // ============================================================

    function renderClasses(results) {
        classListEl.innerHTML = '';

        for (const item of results) {
            const remaining =
                item.capacity -
                item.current;

            const selected =
                item.classKey ===
                selectedClassKey;

            const box =
                document.createElement('div');

            box.style.cssText = `
                margin-top:5px;
                padding:7px 9px;
                border-radius:6px;
                background:
                    ${selected
                        ? 'rgba(80,160,255,.18)'
                        : 'rgba(255,255,255,.05)'};
                border:
                    ${selected
                        ? '1px solid rgba(100,180,255,.8)'
                        : '1px solid transparent'};
            `;

            box.innerHTML = `
                <div style="font-weight:bold;">
                    ${selected ? '▶ ' : ''}
                    ${escapeHtml(item.classNo)}班
                    ${selected ? '【正在监控】' : ''}
                </div>

                <div>
                    ${escapeHtml(item.courseName)}
                </div>

                <div>
                    ${
                        remaining > 0

                            ? `<span style="
                                color:#5cff79;
                                font-weight:bold;
                               ">
                                有 ${remaining} 个名额
                               </span>`

                            : `<span style="
                                color:#ff7676;
                               ">
                                已满
                               </span>`
                    }

                    &nbsp;
                    已选 ${item.current} / 容量 ${item.capacity}
                </div>
            `;

            classListEl.appendChild(
                box
            );
        }
    }

    // ============================================================
    // 声音
    // ============================================================

    function beep() {
        try {
            if (!audioContext) {
                audioContext =
                    new (
                        window.AudioContext ||
                        window.webkitAudioContext
                    )();
            }

            const oscillator =
                audioContext.createOscillator();

            const gain =
                audioContext.createGain();

            oscillator.frequency.value =
                1400;

            gain.gain.value =
                0.3;

            oscillator.connect(gain);

            gain.connect(
                audioContext.destination
            );

            oscillator.start();

            setTimeout(
                () => oscillator.stop(),
                500
            );

        } catch (e) {
            console.error(e);
        }
    }

    function flashTitle(message) {
        const oldTitle =
            document.title;

        let count = 0;

        const timer =
            setInterval(() => {
                document.title =
                    count % 2 === 0
                        ? message
                        : oldTitle;

                count++;

                if (count >= 30) {
                    clearInterval(timer);
                    document.title =
                        oldTitle;
                }

            }, 500);
    }

    // ============================================================
    // Server酱
    // ============================================================

    function getSendKey() {
        return (
            GM_getValue(
                'SERVERCHAN_SENDKEY',
                ''
            ) || ''
        ).trim();
    }

    function refreshServerStatus() {
        if (getSendKey()) {
            serverConfigEl.innerHTML =
                `Server酱：
                 <span style="
                     color:#5cff79;
                     font-weight:bold;
                 ">
                     已配置
                 </span>`;
        } else {
            serverConfigEl.innerHTML =
                `Server酱：
                 <span style="
                     color:#ffb347;
                 ">
                     未配置 SendKey
                 </span>`;
        }
    }

    function setSendKey() {
        const value =
            prompt(
                '请输入 Server酱 SendKey：',
                getSendKey()
            );

        if (value === null) return;

        GM_setValue(
            'SERVERCHAN_SENDKEY',
            value.trim()
        );

        refreshServerStatus();

        alert('SendKey 已保存。');
    }

    function getServerChanURL(sendKey) {
        if (
            sendKey
                .toLowerCase()
                .startsWith('sctp')
        ) {
            const match =
                sendKey.match(
                    /^sctp(\d+)t/i
                );

            if (!match) {
                throw new Error(
                    'SendKey 格式错误'
                );
            }

            return (
                `https://${match[1]}.push.ft07.com/` +
                `send/${sendKey}.send`
            );
        }

        return (
            `https://sctapi.ftqq.com/` +
            `${sendKey}.send`
        );
    }

    function sendServerChan(
        title,
        desp
    ) {
        return new Promise(
            (resolve, reject) => {

                const sendKey =
                    getSendKey();

                if (!sendKey) {
                    reject(
                        new Error(
                            '尚未设置 SendKey'
                        )
                    );
                    return;
                }

                let url;

                try {
                    url =
                        getServerChanURL(
                            sendKey
                        );
                } catch (e) {
                    reject(e);
                    return;
                }

                const body =
                    'title=' +
                    encodeURIComponent(title) +
                    '&desp=' +
                    encodeURIComponent(desp);

                GM_xmlhttpRequest({
                    method: 'POST',
                    url,

                    headers: {
                        'Content-Type':
                            'application/x-www-form-urlencoded;charset=UTF-8'
                    },

                    data: body,
                    timeout: 15000,

                    onload(response) {
                        try {
                            const json =
                                JSON.parse(
                                    response.responseText
                                );

                            if (
                                response.status >= 200 &&
                                response.status < 300 &&
                                Number(json.code) === 0
                            ) {
                                resolve(json);
                            } else {
                                reject(
                                    new Error(
                                        json.message ||
                                        json.msg ||
                                        `HTTP ${response.status}`
                                    )
                                );
                            }

                        } catch {
                            reject(
                                new Error(
                                    'Server酱响应解析失败'
                                )
                            );
                        }
                    },

                    onerror() {
                        reject(
                            new Error(
                                'Server酱网络请求失败'
                            )
                        );
                    },

                    ontimeout() {
                        reject(
                            new Error(
                                'Server酱请求超时'
                            )
                        );
                    }
                });
            }
        );
    }

    async function testServerChan() {
        if (!getSendKey()) {
            alert('请先设置 SendKey。');
            return;
        }

        try {
            await sendServerChan(
                '【测试】深大选课监控',

                [
                    '## Server酱推送测试',
                    '',
                    `课程号：${getCourseCode() || '未填写'}`,
                    '',
                    `监控教学班：${selectedClassKey || '未选择'}`,
                    '',
                    `时间：${nowText()}`
                ].join('\n')
            );

            serverStatusEl.innerHTML =
                `上次推送：
                 <span style="
                    color:#5cff79;
                    font-weight:bold;
                 ">
                    测试成功
                 </span>
                 ${new Date().toLocaleTimeString()}`;

        } catch (e) {
            serverStatusEl.innerHTML =
                `<span style="color:#ff6b6b">
                    推送失败：${escapeHtml(e.message)}
                 </span>`;
        }
    }

    // ============================================================
    // 报警
    // ============================================================

    function shouldPush(item) {
        const key =
            `LAST_PUSH_${item.courseCode}_${item.classNo}`;

        const old =
            GM_getValue(
                key,
                null
            );

        const signature =
            `已选 ${item.current} / 容量 ${item.capacity}`;

        const now =
            Date.now();

        if (
            old &&
            old.signature === signature &&
            now - old.time <
                DUPLICATE_PUSH_INTERVAL
        ) {
            return false;
        }

        GM_setValue(
            key,
            {
                signature,
                time: now
            }
        );

        return true;
    }

    async function alarm(
        item,
        reason
    ) {
        const remaining =
            item.capacity -
                item.current;

        beep();
        setTimeout(beep, 700);
        setTimeout(beep, 1400);
        setTimeout(beep, 2100);

        GM_notification({
            title:
                '深圳大学选课提醒',

            text:
                `${item.courseName}（${item.classNo}班）\n` +
                `${reason}\n` +
                `已选 ${item.current} / 容量 ${item.capacity}\n` +
                `剩余 ${remaining} 个名额`,

            timeout:
                20000
        });

        flashTitle(
            `【${item.classNo}班有名额】${item.courseName}`
        );

        if (!getSendKey()) {
            return;
        }

        if (!shouldPush(item)) {
            return;
        }

        try {
            await sendServerChan(

                `【选课有名额】${item.courseName}（${item.classNo}班）`,

                [
                    '## 🚨 深圳大学选课提醒',
                    '',
                    `**课程：** ${item.courseName}`,
                    '',
                    `**课程号：** ${item.courseCode}`,
                    '',
                    `**目标教学班：** ${item.classNo}`,
                    '',
                    `**情况：** ${reason}`,
                    '',
                    `**当前人数：** ${item.current}`,
                    '',
                    `**容量：** ${item.capacity}`,
                    '',
                    `**剩余名额：** ${remaining}`,
                    '',
                    `**发现时间：** ${nowText()}`
                ].join('\n')
            );

            serverStatusEl.innerHTML =
                `上次推送：
                 <span style="
                    color:#5cff79;
                    font-weight:bold;
                 ">
                    ${escapeHtml(item.classNo)}班成功
                 </span>
                 ${new Date().toLocaleTimeString()}`;

        } catch (e) {
            serverStatusEl.innerHTML =
                `<span style="color:#ff6b6b">
                    推送失败：${escapeHtml(e.message)}
                 </span>`;
        }
    }

    // ============================================================
    // 只处理用户选中的教学班
    // ============================================================

    function processResults(results) {
        lastResults =
            results;

        const courseCode =
            results[0].courseCode;

        if (
            courseCode !== activeCourseCode
        ) {
            activeCourseCode =
                courseCode;

            selectedClassKey =
                getSavedClass(courseCode);

            lastCurrent = null;
            lastCapacity = null;
            queryCount = 0;
        }

        queryCount++;

        courseEl.textContent =
            `监控课程：${courseCode}`;

        updateClassSelector(
            results
        );

        renderClasses(
            results
        );

        timeEl.textContent =
            `上次查询：${new Date().toLocaleTimeString()}`;

        countEl.textContent =
            `查询次数：${queryCount}`;

        if (!selectedClassKey) {
            targetEl.textContent =
                '当前目标：未选择';

            statusEl.innerHTML =
                `<span style="
                    color:#ffb347;
                    font-weight:bold;
                ">
                    查询到 ${results.length} 个教学班，
                    请在上方选择你真正想监控的班
                </span>`;

            return;
        }

        const item =
            results.find(
                x =>
                    x.classKey ===
                    selectedClassKey
            );

        if (!item) {
            statusEl.innerHTML =
                '<span style="color:#ff6b6b">' +
                '没有找到所选教学班' +
                '</span>';

            return;
        }

        const remaining =
            item.capacity -
            item.current;

        targetEl.textContent =
            `当前目标：${item.classNo}班 ` +
            `已选 ${item.current} / 容量 ${item.capacity}`;

        if (remaining > 0) {
            statusEl.innerHTML =
                `目标 ${item.classNo} 班：
                 <span style="
                     color:#5cff79;
                     font-size:16px;
                     font-weight:bold;
                 ">
                     有 ${remaining} 个名额
                 </span>`;
        } else {
            statusEl.innerHTML =
                `目标 ${item.classNo} 班：
                 <span style="
                     color:#ff7676;
                     font-weight:bold;
                 ">
                     已满
                 </span>
                 （已选 ${item.current} / 容量 ${item.capacity}）`;
        }

        if (
            lastCurrent === null ||
            lastCapacity === null
        ) {
            lastCurrent =
                item.current;

            lastCapacity =
                item.capacity;

            if (remaining > 0) {
                alarm(
                    item,
                    '当前已经有可选名额！'
                );
            }

            return;
        }

        const oldRemaining =
            lastCapacity -
            lastCurrent;

        if (
            item.capacity >
            lastCapacity
        ) {
            alarm(
                item,
                `目标教学班扩容：` +
                `${lastCapacity} → ${item.capacity}`
            );
        }

        else if (
            oldRemaining <= 0 &&
            remaining > 0
        ) {
            alarm(
                item,
                '目标教学班出现可选名额！'
            );
        }

        else if (
            remaining >
                oldRemaining &&
            remaining > 0
        ) {
            alarm(
                item,
                `目标教学班剩余名额增加：` +
                `${oldRemaining} → ${remaining}`
            );
        }

        lastCurrent =
            item.current;

        lastCapacity =
            item.capacity;
    }

    // ============================================================
    // 查询
    // ============================================================

    async function checkCourse() {
        if (checking) {
            return;
        }

        if (!isOpenCoursePage()) {
            statusEl.innerHTML =
                '<span style="color:#ffb347">' +
                '请手动进入「已开课程查询」' +
                '</span>';

            return;
        }

        const courseCode =
            getCourseCode();

        if (!courseCode) {
            activeCourseCode = '';
            selectedClassKey = '';

            lastCurrent = null;
            lastCapacity = null;

            classSelectEl.innerHTML =
                '<option>等待查询</option>';

            classListEl.innerHTML = '';

            statusEl.innerHTML =
                '<span style="color:#ffb347">' +
                '请填写课程号' +
                '</span>';

            return;
        }

        checking = true;

        try {
            statusEl.innerHTML =
                `<span style="color:#66b3ff">
                    正在查询 ${escapeHtml(courseCode)}……
                 </span>`;

            const button =
                findQueryButton();

            if (!button) {
                throw new Error(
                    '没有找到查询按钮'
                );
            }

            button.click();

            await sleep(
                WAIT_AFTER_QUERY
            );

            const results =
                readCourseResults(
                    courseCode
                );

            processResults(
                results
            );

        } catch (e) {
            statusEl.innerHTML =
                `<span style="color:#ff6b6b">
                    ${escapeHtml(e.message)}
                 </span>`;

            console.error(e);

        } finally {
            checking = false;
        }
    }

    // ============================================================
    // 按钮
    // ============================================================

    document
        .getElementById('szu-now')
        .addEventListener(
            'click',
            checkCourse
        );

    document
        .getElementById('szu-test')
        .addEventListener(
            'click',
            () => {
                beep();

                GM_notification({
                    title:
                        '深大选课监控',
                    text:
                        '本地提醒正常',
                    timeout:
                        5000
                });
            }
        );

    document
        .getElementById('server-set')
        .addEventListener(
            'click',
            setSendKey
        );

    document
        .getElementById('server-test')
        .addEventListener(
            'click',
            testServerChan
        );

    // ============================================================
    // 启动
    // ============================================================

    refreshServerStatus();

    setTimeout(
        checkCourse,
        1000
    );

    setInterval(
        checkCourse,
        INTERVAL
    );

})();
