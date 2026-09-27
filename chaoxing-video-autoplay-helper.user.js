// ==UserScript==
// @name         学习通严格顺序连续播放 v22.4
// @namespace    chaoxing-sequential-v22
// @version      22.4
// @description  自动静音、鼠标移出不暂停、后台保活、严格顺序自动下一课，并在视频判断题出现时响铃和闪烁标签页
// @match        https://*.chaoxing.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TAG = '[学习通 v22.4]';

    const FRAME_ID =
        'cx22_' +
        Date.now() +
        '_' +
        Math.random()
            .toString(36)
            .slice(2);

    let activeLessonKey = '';
    let activeLessonTitle = '';

    let localLessonNodes =
        new Map();


    function log(...args) {
        console.log(
            TAG,
            ...args
        );
    }


    // ============================================================
    // 0. 鼠标移出网页不暂停
    // ============================================================

    function blockMouseOut(event) {

        const leavingPage =
            event.relatedTarget === null ||
            !document.documentElement.contains(
                event.relatedTarget
            );


        if (!leavingPage) {
            return;
        }


        event.stopImmediatePropagation();
        event.stopPropagation();


        log(
            '已拦截鼠标离开页面事件'
        );
    }


    window.addEventListener(
        'mouseout',
        blockMouseOut,
        true
    );


    document.addEventListener(
        'mouseout',
        blockMouseOut,
        true
    );


    // ============================================================
    // 1. 基础工具
    // ============================================================

    function normalize(text) {

        return String(
            text || ''
        )
            .replace(
                /\s+/g,
                ' '
            )
            .trim();
    }


    function isVisible(element) {

        if (!element) {
            return false;
        }


        try {

            const style =
                getComputedStyle(
                    element
                );


            const rect =
                element
                    .getBoundingClientRect();


            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity) !== 0 &&
                rect.width > 10 &&
                rect.height > 10
            );

        } catch (e) {

            return false;
        }
    }


    function muteVideo(video) {

        try {

            video.muted = true;

            video.defaultMuted = true;


            if (
                video.volume !==
                0
            ) {

                video.volume = 0;
            }

        } catch (e) {}
    }


    // ============================================================
    // 2. 判断题提醒
    //
    // 检测：
    // input[name="ans-videoquiz-opt"]
    // #videoquiz-submit
    //
    // 检测到以后：
    //
    // 响两声
    // +
    // 标签页标题闪烁
    //
    // 不自动答题
    // 不自动提交
    // ============================================================

    const quizActiveFrames =
        new Map();


    let quizFlashTimer =
        null;


    let quizOriginalTitle =
        '';


    let localQuizWasActive =
        false;

    // 每个 iframe 都维护同一把题目锁，由顶层页面广播状态。
    let quizIsActive = false;
    let quizRecoveryPending = false;
    let quizResumeTimer = null;
    let quizLockGeneration = 0;

    function resumeAfterQuiz() {
        if (quizIsActive || detectVideoQuiz()) {
            return;
        }

        const candidates = Array.from(document.querySelectorAll('video'))
            .filter(video =>
                video.isConnected &&
                isVisible(video) &&
                !video.ended &&
                Number.isFinite(Number(video.duration)) &&
                Number(video.duration) > 0
            );

        // 优先恢复当前课程的播放器，避免唤醒旧课或隐藏播放器。
        const video = candidates.find(candidate =>
            activeLessonKey &&
            candidate.dataset.cx22LessonKey === activeLessonKey
        ) || candidates[0];

        if (!video) {
            return;
        }

        muteVideo(video);
        bindVideo(video);

        if (video.paused) {
            try {
                const result = video.play();
                if (result && typeof result.catch === 'function') {
                    result.catch(() => {});
                }
                log('判断题消失后，尝试恢复当前视频');
            } catch (e) {}
        }
    }

    function setQuizLock(active) {
        const next = !!active;
        if (quizIsActive === next) {
            return;
        }

        quizIsActive = next;
        quizLockGeneration += 1;
        clearTimeout(quizResumeTimer);
        quizResumeTimer = null;

        if (next) {
            quizRecoveryPending = false;
            log('判断题锁定：暂停自动恢复');
            return;
        }

        quizRecoveryPending = true;
        const generation = quizLockGeneration;
        quizResumeTimer = setTimeout(() => {
            quizResumeTimer = null;
            if (generation === quizLockGeneration) {
                quizRecoveryPending = false;
                resumeAfterQuiz();
            }
        }, 700);
        log('判断题锁解除：约 700ms 后恢复当前视频');
    }


    function quizElementVisible(
        element
    ) {

        if (!element) {
            return false;
        }


        try {

            const style =
                getComputedStyle(
                    element
                );


            const rect =
                element
                    .getBoundingClientRect();


            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                Number(style.opacity) !== 0 &&
                rect.width > 0 &&
                rect.height > 0
            );

        } catch (e) {

            return false;
        }
    }


    function detectVideoQuiz() {

        const radios =
            Array.from(
                document
                    .querySelectorAll(
                        'input[type="radio"][name="ans-videoquiz-opt"]'
                    )
            );


        /*
         * input 本身有可能被 CSS 隐藏，
         * 所以判断它外面的 label 是否可见。
         */
        const visibleLabels =
            radios
                .map(
                    radio =>
                        radio.closest(
                            'label'
                        )
                )
                .filter(
                    Boolean
                )
                .filter(
                    quizElementVisible
                );


        const submit =
            document
                .querySelector(
                    '#videoquiz-submit'
                );


        return (
            radios.length >= 2 &&
            visibleLabels.length >= 2 &&
            submit &&
            quizElementVisible(
                submit
            )
        );
    }


    // ------------------------------------------------------------
    // 提示音
    // ------------------------------------------------------------

    function playQuizAlertSound() {

        try {

            const AudioCtx =
                window.AudioContext ||
                window.webkitAudioContext;


            if (!AudioCtx) {
                return;
            }


            const ctx =
                new AudioCtx();


            function playTone(
                frequency,
                start,
                duration
            ) {

                const osc =
                    ctx.createOscillator();


                const gain =
                    ctx.createGain();


                osc.type =
                    'sine';


                osc.frequency.value =
                    frequency;


                gain.gain.value =
                    0.18;


                osc.connect(
                    gain
                );


                gain.connect(
                    ctx.destination
                );


                osc.start(
                    ctx.currentTime +
                    start
                );


                osc.stop(
                    ctx.currentTime +
                    start +
                    duration
                );
            }


            function begin() {

                /*
                 * 两声短提示。
                 */
                playTone(
                    880,
                    0,
                    0.16
                );


                playTone(
                    1100,
                    0.28,
                    0.18
                );


                setTimeout(
                    () => {

                        try {

                            ctx.close();

                        } catch (e) {}

                    },
                    900
                );
            }


            if (
                ctx.state ===
                    'suspended' &&
                typeof ctx.resume ===
                    'function'
            ) {

                ctx.resume()
                    .then(
                        begin
                    )
                    .catch(
                        () => {}
                    );

            } else {

                begin();
            }

        } catch (e) {

            log(
                '判断题提示音播放失败',
                e
            );
        }
    }


    // ------------------------------------------------------------
    // 标签页闪烁
    // ------------------------------------------------------------

    function startQuizTabFlash() {

        /*
         * 只有最外层页面的 title
         * 才是真正浏览器标签页标题。
         */
        if (
            window !==
            window.top
        ) {

            return;
        }


        if (
            quizFlashTimer
        ) {

            return;
        }


        quizOriginalTitle =
            document.title;


        let state =
            false;


        quizFlashTimer =
            setInterval(
                () => {

                    state =
                        !state;


                    document.title =
                        state
                            ? '⚠️ 学习通需要操作！'
                            : '🔔 视频判断题等待操作';

                },
                700
            );
    }


    function stopQuizTabFlash() {

        if (
            window !==
            window.top
        ) {

            return;
        }


        if (
            quizFlashTimer
        ) {

            clearInterval(
                quizFlashTimer
            );


            quizFlashTimer =
                null;
        }


        if (
            quizOriginalTitle
        ) {

            document.title =
                quizOriginalTitle;


            quizOriginalTitle =
                '';
        }
    }


    // ------------------------------------------------------------
    // 顶层统一管理判断题状态
    // ------------------------------------------------------------

    function coordinatorSetQuizState(
        frameId,
        active
    ) {

        if (
            window !==
            window.top
        ) {

            return;
        }


        const hadAny =
            quizActiveFrames.size >
            0;


        if (
            active
        ) {

            quizActiveFrames
                .set(
                    frameId,
                    Date.now()
                );

        } else {

            quizActiveFrames
                .delete(
                    frameId
                );
        }


        const hasAny =
            quizActiveFrames.size >
            0;

        if (hadAny !== hasAny) {
            setQuizLock(hasAny);
            coordinatorBroadcast({
                type: 'CX22_QUIZ_LOCK',
                active: hasAny
            });
        }


        /*
         * 从“没有题”变成“有题”
         * 才响一次。
         */
        if (
            !hadAny &&
            hasAny
        ) {

            log(
                '检测到视频中途判断题，开始提醒'
            );


            playQuizAlertSound();


            startQuizTabFlash();
        }


        /*
         * 弹窗完全消失后重置。
         */
        if (
            hadAny &&
            !hasAny
        ) {

            stopQuizTabFlash();


            log(
                '判断题弹窗已消失，提醒状态重置'
            );
        }
    }


    function sendQuizState(
        active
    ) {

        const message = {

            type:
                'CX22_QUIZ_STATE',

            frameId:
                FRAME_ID,

            active:
                !!active
        };


        try {

            if (
                window ===
                window.top
            ) {

                coordinatorSetQuizState(
                    FRAME_ID,
                    !!active
                );

            } else {

                window.top
                    .postMessage(
                        message,
                        '*'
                    );
            }

        } catch (e) {}
    }


    function checkVideoQuiz() {

        const active =
            detectVideoQuiz();


        /*
         * 弹窗存在时持续发心跳。
         */
        if (
            active
        ) {

            // 本帧先上锁，避免等待跨 iframe 消息期间自动播放。
            setQuizLock(true);

            sendQuizState(
                true
            );

        } else if (
            localQuizWasActive
        ) {

            /*
             * 从存在 → 消失时通知顶层。
             */
            sendQuizState(
                false
            );
        }


        localQuizWasActive =
            !!active;
    }


    function startVideoQuizAlert() {

        checkVideoQuiz();


        /*
         * 弹窗通常是动态插入或通过 class/style 显示。
         */
        const observer =
            new MutationObserver(
                checkVideoQuiz
            );


        observer.observe(
            document.documentElement,
            {

                childList:
                    true,

                subtree:
                    true,

                attributes:
                    true,

                attributeFilter: [
                    'style',
                    'class'
                ]
            }
        );


        /*
         * 第二保险。
         */
        setInterval(
            checkVideoQuiz,
            800
        );


        /*
         * 顶层清理已经被销毁的 iframe。
         */
        if (
            window ===
            window.top
        ) {

            setInterval(
                () => {

                    // 后台计时器可能被浏览器降频，不能据此误判题目消失。
                    if (getRealHidden()) {
                        return;
                    }

                    const now =
                        Date.now();


                    for (
                        const [
                            frameId,
                            lastSeen
                        ]
                        of quizActiveFrames
                    ) {

                        if (
                            now -
                                lastSeen >
                            10000
                        ) {

                            coordinatorSetQuizState(frameId, false);
                        }
                    }

                },
                1500
            );
        }


        log(
            '视频判断题提醒已启用'
        );
    }


    // ============================================================
    // 3. 后台播放保活
    // ============================================================

    const hiddenDescriptor =
        Object
            .getOwnPropertyDescriptor(
                Document.prototype,
                'hidden'
            );


    const visibilityDescriptor =
        Object
            .getOwnPropertyDescriptor(
                Document.prototype,
                'visibilityState'
            );


    const webkitHiddenDescriptor =
        Object
            .getOwnPropertyDescriptor(
                Document.prototype,
                'webkitHidden'
            );


    const webkitVisibilityDescriptor =
        Object
            .getOwnPropertyDescriptor(
                Document.prototype,
                'webkitVisibilityState'
            );


    function getRealHidden() {

        try {

            if (
                hiddenDescriptor &&
                typeof hiddenDescriptor.get ===
                    'function'
            ) {

                return !!hiddenDescriptor
                    .get
                    .call(
                        document
                    );
            }

        } catch (e) {}


        try {

            if (
                visibilityDescriptor &&
                typeof visibilityDescriptor.get ===
                    'function'
            ) {

                return (
                    visibilityDescriptor
                        .get
                        .call(
                            document
                        ) !==
                    'visible'
                );
            }

        } catch (e) {}


        return false;
    }


    function fakeDocumentProperty(
        name,
        value
    ) {

        try {

            Object.defineProperty(
                document,
                name,
                {

                    configurable:
                        true,

                    get() {

                        return value;
                    }
                }
            );

        } catch (e) {}
    }


    fakeDocumentProperty(
        'hidden',
        false
    );


    fakeDocumentProperty(
        'visibilityState',
        'visible'
    );


    if (
        webkitHiddenDescriptor
    ) {

        fakeDocumentProperty(
            'webkitHidden',
            false
        );
    }


    if (
        webkitVisibilityDescriptor
    ) {

        fakeDocumentProperty(
            'webkitVisibilityState',
            'visible'
        );
    }


    let backgroundMode =
        false;


    const backgroundVideos =
        new Set();


    function rememberPlayingVideos() {

        document
            .querySelectorAll(
                'video'
            )
            .forEach(
                video => {

                    try {

                        if (
                            !video.paused &&
                            !video.ended
                        ) {

                            backgroundVideos
                                .add(
                                    video
                                );
                        }

                    } catch (e) {}
                }
            );
    }


    function resumeBackgroundVideo(
        video
    ) {

        if (
            quizIsActive ||
            quizRecoveryPending ||
            detectVideoQuiz() ||
            !backgroundMode ||
            !backgroundVideos.has(
                video
            )
        ) {

            return;
        }


        try {

            if (
                !video.isConnected ||
                video.ended
            ) {

                backgroundVideos
                    .delete(
                        video
                    );


                return;
            }


            muteVideo(
                video
            );


            if (
                !video.paused
            ) {

                return;
            }


            if (
                Number(
                    video.currentTime
                ) <= 0
            ) {

                return;
            }


            const result =
                video.play();


            if (
                result &&
                typeof result.catch ===
                    'function'
            ) {

                result.catch(
                    () => {}
                );
            }


            log(
                '后台检测到暂停，已尝试恢复播放：',
                Number(
                    video.currentTime
                ).toFixed(
                    1
                )
            );

        } catch (e) {}
    }


    function resumeBackgroundVideos() {

        if (
            quizIsActive ||
            quizRecoveryPending ||
            detectVideoQuiz() ||
            !backgroundMode
        ) {

            return;
        }


        for (
            const video
            of Array.from(
                backgroundVideos
            )
        ) {

            resumeBackgroundVideo(
                video
            );
        }
    }


    function bindBackgroundVideo(
        video
    ) {

        if (
            video.dataset
                .cx22BackgroundBound ===
            '1'
        ) {

            return;
        }


        video.dataset
            .cx22BackgroundBound =
            '1';


        video.addEventListener(
            'play',
            () => {

                muteVideo(
                    video
                );


                if (
                    backgroundMode
                ) {

                    backgroundVideos
                        .add(
                            video
                        );
                }

            },
            true
        );


        video.addEventListener(
            'ended',
            () => {

                backgroundVideos
                    .delete(
                        video
                    );

            },
            true
        );


        video.addEventListener(
            'pause',
            () => {

                if (
                    !backgroundMode ||
                    !backgroundVideos.has(
                        video
                    ) ||
                    video.ended
                ) {

                    return;
                }


                setTimeout(
                    () => {

                        resumeBackgroundVideo(
                            video
                        );

                    },
                    80
                );


                setTimeout(
                    () => {

                        resumeBackgroundVideo(
                            video
                        );

                    },
                    300
                );

            },
            true
        );
    }


    function scanBackgroundVideos() {

        document
            .querySelectorAll(
                'video'
            )
            .forEach(
                bindBackgroundVideo
            );
    }


    function enterBackground(
        event
    ) {

        rememberPlayingVideos();


        backgroundMode =
            true;


        if (
            event
        ) {

            try {

                event
                    .stopImmediatePropagation();


                event
                    .stopPropagation();

            } catch (e) {}
        }


        log(
            '进入后台，保活视频数量：',
            backgroundVideos.size
        );


        [
            50,
            200,
            500,
            1000,
            2000
        ]
            .forEach(
                delay => {

                    setTimeout(
                        resumeBackgroundVideos,
                        delay
                    );
                }
            );
    }


    function leaveBackground(
        event
    ) {

        backgroundMode =
            false;


        backgroundVideos
            .clear();


        /*
         * 用户回到这个标签页，
         * 判断题标题停止闪烁。
         */
        if (
            window ===
            window.top
        ) {

            stopQuizTabFlash();
        }


        if (
            event
        ) {

            try {

                event
                    .stopImmediatePropagation();


                event
                    .stopPropagation();

            } catch (e) {}
        }


        log(
            '页面回到前台'
        );
    }


    function handleVisibilityChange(
        event
    ) {

        const realHidden =
            getRealHidden();


        try {

            event
                .stopImmediatePropagation();


            event
                .stopPropagation();

        } catch (e) {}


        if (
            realHidden
        ) {

            enterBackground();

        } else {

            leaveBackground();
        }
    }


    window.addEventListener(
        'blur',
        enterBackground,
        true
    );


    window.addEventListener(
        'focus',
        leaveBackground,
        true
    );


    document.addEventListener(
        'visibilitychange',
        handleVisibilityChange,
        true
    );


    document.addEventListener(
        'webkitvisibilitychange',
        handleVisibilityChange,
        true
    );


    function startBackgroundGuard() {

        scanBackgroundVideos();


        setInterval(
            () => {

                scanBackgroundVideos();


                if (
                    backgroundMode
                ) {

                    resumeBackgroundVideos();
                }

            },
            1000
        );


        log(
            '后台播放保护已启用'
        );
    }


    // ============================================================
    // 4. 解析三级课程
    // ============================================================

    function parseLesson(text) {

        const match =
            normalize(
                text
            )
                .match(
                    /^(\d+)\.(\d+)\.(\d+)\s+(.+)$/
                );


        if (!match) {
            return null;
        }


        return {

            a:
                Number(
                    match[1]
                ),

            b:
                Number(
                    match[2]
                ),

            c:
                Number(
                    match[3]
                ),

            key:
                match[1] +
                '.' +
                match[2] +
                '.' +
                match[3],

            title:
                normalize(
                    match[4]
                )
        };
    }


    // ============================================================
    // 5. 抓取左上角课程标题候选
    // ============================================================

    function getLocalTitleCandidates() {

        const selector =
            'h1,h2,h3,h4,' +
            '[class*="title"],' +
            '[class*="name"],' +
            '[class*="chapter"],' +
            'div,span,p';


        const elements =
            document
                .querySelectorAll(
                    selector
                );


        const bestByText =
            new Map();


        for (
            const element
            of elements
        ) {

            if (
                !isVisible(
                    element
                )
            ) {

                continue;
            }


            const text =
                normalize(
                    element.innerText
                );


            if (
                text.length < 2 ||
                text.length > 80
            ) {

                continue;
            }


            let style;


            try {

                style =
                    getComputedStyle(
                        element
                    );

            } catch (e) {

                continue;
            }


            const fontSize =
                parseFloat(
                    style.fontSize
                ) || 0;


            const fontWeight =
                parseInt(
                    style.fontWeight,
                    10
                ) || 400;


            const tag =
                element
                    .tagName
                    .toLowerCase();


            const className =
                String(
                    element.className ||
                    ''
                )
                    .toLowerCase();


            const headingLike =
                /^h[1-4]$/
                    .test(
                        tag
                    );


            const namedLike =
                /title|name|chapter/
                    .test(
                        className
                    );


            const numbered =
                /^\d+(?:\.\d+){0,2}\s+/
                    .test(
                        text
                    );


            if (
                !headingLike &&
                !namedLike &&
                fontSize < 18
            ) {

                continue;
            }


            let score =
                fontSize *
                10;


            if (
                headingLike
            ) {

                score +=
                    100;
            }


            if (
                namedLike
            ) {

                score +=
                    60;
            }


            if (
                fontWeight >=
                600
            ) {

                score +=
                    25;
            }


            if (
                numbered
            ) {

                score -=
                    180;
            }


            const old =
                bestByText
                    .get(
                        text
                    );


            if (
                !old ||
                score >
                    old.score
            ) {

                bestByText
                    .set(
                        text,
                        {

                            text,

                            score,

                            fontSize,

                            tag
                        }
                    );
            }
        }


        return Array.from(
            bestByText.values()
        )
            .sort(
                (a, b) =>
                    b.score -
                    a.score
            )
            .slice(
                0,
                80
            );
    }


    // ============================================================
    // 6. 扫描三级目录
    // ============================================================

    function scanLocalLessons() {

        const nodes =
            document
                .querySelectorAll(
                    'a,li,div,span,p'
                );


        const map =
            new Map();


        const nodeMap =
            new Map();


        for (
            const element
            of nodes
        ) {

            const text =
                normalize(
                    element.innerText
                );


            if (!text) {
                continue;
            }


            const parsed =
                parseLesson(
                    text
                );


            if (!parsed) {
                continue;
            }


            const numbers =
                text.match(
                    /\d+\.\d+\.\d+/g
                );


            if (
                numbers &&
                numbers.length !==
                    1
            ) {

                continue;
            }


            if (
                text.length >
                180
            ) {

                continue;
            }


            let clickable =
                element;


            if (
                !element.matches(
                    'a,button,[onclick],[role="button"]'
                )
            ) {

                const child =
                    element
                        .querySelector(
                            'a,button,[onclick],[role="button"]'
                        );


                if (
                    child
                ) {

                    clickable =
                        child;
                }
            }


            const old =
                map.get(
                    parsed.key
                );


            if (
                old
            ) {

                const oldLength =
                    normalize(
                        old.text
                    )
                        .length;


                const newLength =
                    text.length;


                if (
                    newLength >=
                    oldLength
                ) {

                    continue;
                }
            }


            map.set(
                parsed.key,
                {

                    key:

                        parsed.key,

                    a:

                        parsed.a,

                    b:

                        parsed.b,

                    c:

                        parsed.c,

                    title:

                        parsed.title,

                    text:

                        parsed.key +
                        ' ' +
                        parsed.title,

                    visible:

                        isVisible(
                            clickable
                        )
                }
            );


            nodeMap.set(
                parsed.key,
                clickable
            );
        }


        localLessonNodes =
            nodeMap;


        const lessons =
            Array.from(
                map.values()
            );


        lessons.sort(
            (x, y) => {

                if (
                    x.a !==
                    y.a
                ) {

                    return (
                        x.a -
                        y.a
                    );
                }


                if (
                    x.b !==
                    y.b
                ) {

                    return (
                        x.b -
                        y.b
                    );
                }


                return (
                    x.c -
                    y.c
                );
            }
        );


        return lessons;
    }


    // ============================================================
    // 7. iframe 向顶层汇报状态
    // ============================================================

    function buildState() {

        return {

            type:
                'CX22_STATE',

            frameId:
                FRAME_ID,

            titles:
                getLocalTitleCandidates(),

            lessons:
                scanLocalLessons(),

            href:
                location.href,

            time:
                Date.now()
        };
    }


    function sendState() {

        const state =
            buildState();


        try {

            if (
                window ===
                window.top
            ) {

                coordinatorReceiveState(
                    window,
                    state
                );

            } else {

                window.top
                    .postMessage(
                        state,
                        '*'
                    );
            }

        } catch (e) {}
    }


    // ============================================================
    // 8. 当前 iframe 尝试播放
    // ============================================================

    function tryPlayLocal() {

        // 包括播放器中央按钮在内的所有自动恢复都受题目锁约束。
        if (quizIsActive || quizRecoveryPending || detectVideoQuiz()) {
            return;
        }

        const videos =
            Array.from(
                document
                    .querySelectorAll(
                        'video'
                    )
            );


        let anyPlaying =
            false;


        for (
            const video
            of videos
        ) {

            muteVideo(
                video
            );


            bindVideo(
                video
            );


            bindBackgroundVideo(
                video
            );


            if (
                !isVisible(
                    video
                )
            ) {

                continue;
            }


            if (
                video.ended
            ) {

                continue;
            }


            if (
                !video.paused
            ) {

                anyPlaying =
                    true;


                continue;
            }


            try {

                const promise =
                    video.play();


                if (
                    promise &&
                    typeof promise.then ===
                        'function'
                ) {

                    promise
                        .then(
                            () => {

                                muteVideo(
                                    video
                                );
                            }
                        )
                        .catch(
                            () => {}
                        );
                }

            } catch (e) {}
        }


        if (
            !anyPlaying
        ) {

            const buttons =
                Array.from(
                    document
                        .querySelectorAll(
                            '.vjs-big-play-button'
                        )
                );


            for (
                const button
                of buttons
            ) {

                if (
                    !isVisible(
                        button
                    )
                ) {

                    continue;
                }


                try {

                    button.click();


                    log(
                        '点击播放器中央三角'
                    );

                } catch (e) {}


                break;
            }
        }
    }


    // ============================================================
    // 9. 视频监听
    // ============================================================

    function bindVideo(video) {

        muteVideo(
            video
        );


        bindBackgroundVideo(
            video
        );


        if (
            video.dataset
                .cx22Bound ===
            '1'
        ) {

            return;
        }


        video.dataset
            .cx22Bound =
            '1';


        let played =
            false;


        let maxTime =
            0;


        let endedHandled =
            false;


        log(
            '发现播放器'
        );


        video.addEventListener(
            'volumechange',
            () => {

                muteVideo(
                    video
                );
            }
        );


        video.addEventListener(
            'play',
            () => {

                muteVideo(
                    video
                );


                played =
                    true;


                if (
                    activeLessonKey &&
                    !video.dataset
                        .cx22LessonKey
                ) {

                    video.dataset
                        .cx22LessonKey =
                        activeLessonKey;
                }


                log(
                    '视频开始：',

                    video.dataset
                        .cx22LessonKey ||
                        activeLessonKey ||
                        '课程号暂未知',

                    Number(
                        video.currentTime
                    ).toFixed(
                        1
                    ),

                    '/',

                    Number(
                        video.duration
                    ).toFixed(
                        1
                    )
                );
            }
        );


        video.addEventListener(
            'timeupdate',
            () => {

                const current =
                    Number(
                        video.currentTime
                    ) || 0;


                if (
                    current >
                    maxTime
                ) {

                    maxTime =
                        current;
                }
            }
        );


        video.addEventListener(
            'ended',
            () => {

                const current =
                    Number(
                        video.currentTime
                    );


                const duration =
                    Number(
                        video.duration
                    );

                const nativeEnded =
                    video.ended === true;


                log(
                    '收到 ended',
                    {

                        lessonKey:

                            video.dataset
                                .cx22LessonKey ||
                            activeLessonKey ||
                            '',

                        current,

                        duration,

                        maxTime,

                        played,

                        nativeEnded
                    }
                );


                if (
                    endedHandled ||
                    !played
                ) {

                    return;
                }


                const finishedByTime =
                    Number.isFinite(duration) &&
                    duration > 0 &&
                    (current >= duration - 5 ||
                     maxTime >= duration - 5);

                // 原生 ended 优先；时间进度只作为兜底。
                const finished = nativeEnded || finishedByTime;


                if (
                    !finished
                ) {

                    log(
                        '忽略：ended 异常且播放进度没有到结尾'
                    );


                    return;
                }


                endedHandled =
                    true;


                log(
                    '确认视频完整播放结束'
                );


                const message = {

                    type:

                        'CX22_ENDED',

                    lessonKey:

                        video.dataset
                            .cx22LessonKey ||
                        activeLessonKey ||
                        ''
                };


                try {

                    if (
                        window ===
                        window.top
                    ) {

                        coordinatorHandleEnded(
                            message
                        );

                    } else {

                        window.top
                            .postMessage(
                                message,
                                '*'
                            );
                    }

                } catch (e) {}
            }
        );


        try {

            if (
                !video.paused &&
                !video.ended &&
                video.currentTime >
                    0
            ) {

                played =
                    true;


                maxTime =
                    video.currentTime;


                if (
                    activeLessonKey &&
                    !video.dataset
                        .cx22LessonKey
                ) {

                    video.dataset
                        .cx22LessonKey =
                        activeLessonKey;
                }
            }

        } catch (e) {}
    }


    // ============================================================
    // 10. 点击指定课程
    // ============================================================

    function clickLocalLesson(
        key
    ) {

        scanLocalLessons();


        const element =
            localLessonNodes
                .get(
                    key
                );


        if (
            !element
        ) {

            return false;
        }


        try {

            element
                .scrollIntoView(
                    {

                        block:
                            'center'
                    }
                );

        } catch (e) {}


        try {

            element
                .dispatchEvent(
                    new MouseEvent(
                        'mouseover',
                        {

                            bubbles:
                                true,

                            view:
                                window
                        }
                    )
                );


            element
                .dispatchEvent(
                    new MouseEvent(
                        'mousedown',
                        {

                            bubbles:
                                true,

                            cancelable:
                                true,

                            view:
                                window
                        }
                    )
                );


            element
                .dispatchEvent(
                    new MouseEvent(
                        'mouseup',
                        {

                            bubbles:
                                true,

                            cancelable:
                                true,

                            view:
                                window
                        }
                    )
                );


            element.click();


            log(
                '已点击课程：',
                key
            );


            return true;

        } catch (e) {

            return false;
        }
    }


    // ============================================================
    // 11. 顶层协调器
    // ============================================================

    const registry =
        new Map();


    let coordinatorCurrentKey =
        '';


    let coordinatorSwitching =
        false;


    let autoPlayTargetKey =
        '';


    let autoPlayDeadline =
        0;


    function coordinatorPrune() {

        const now =
            Date.now();


        for (
            const [
                key,
                entry
            ]
            of registry
        ) {

            if (
                now -
                    entry.time >
                10000
            ) {

                registry.delete(
                    key
                );
            }
        }
    }


    function coordinatorReceiveState(
        source,
        data
    ) {

        const firstReport = !registry.has(data.frameId);

        registry.set(
            data.frameId,
            {

                source:

                    source,

                frameId:

                    data.frameId,

                titles:

                    Array.isArray(
                        data.titles
                    )
                        ? data.titles
                        : [],

                lessons:

                    Array.isArray(
                        data.lessons
                    )
                        ? data.lessons
                        : [],

                href:

                    data.href ||
                    '',

                time:

                    Date.now()
            }
        );


        coordinatorPrune();

        if (firstReport && source && source !== window) {
            try {
                source.postMessage({
                    type: 'CX22_QUIZ_LOCK',
                    active: quizActiveFrames.size > 0
                }, '*');
            } catch (e) {}
        }


        const current =
            coordinatorDeriveCurrent();


        if (
            !current
        ) {

            return;
        }


        try {

            source.postMessage(
                {

                    type:

                        'CX22_CONTEXT',

                    lessonKey:

                        current.key,

                    lessonTitle:

                        current.title
                },
                '*'
            );

        } catch (e) {}


        if (
            coordinatorCurrentKey !==
            current.key
        ) {

            coordinatorCurrentKey =
                current.key;


            log(
                '协调器识别当前课：',
                current.text,
                '← 左上角标题：',
                current.matchedTitle
            );


            coordinatorBroadcast(
                {

                    type:

                        'CX22_CONTEXT',

                    lessonKey:

                        current.key,

                    lessonTitle:

                        current.title
                }
            );
        }


        if (
            autoPlayTargetKey &&
            current.key ===
                autoPlayTargetKey &&
            Date.now() <
                autoPlayDeadline
        ) {

            try {

                source.postMessage(
                    {

                        type:

                            'CX22_PLAY',

                        lessonKey:

                            current.key,

                        lessonTitle:

                            current.title
                    },
                    '*'
                );

            } catch (e) {}
        }
    }


    function coordinatorGetDirectory() {

        coordinatorPrune();


        let best =
            null;


        for (
            const entry
            of registry.values()
        ) {

            if (
                !best ||
                entry.lessons.length >
                    best.lessons.length
            ) {

                best =
                    entry;
            }
        }


        if (
            !best ||
            best.lessons.length <
                2
        ) {

            return null;
        }


        const lessons =
            [
                ...best.lessons
            ];


        lessons.sort(
            (x, y) => {

                if (
                    x.a !==
                    y.a
                ) {

                    return (
                        x.a -
                        y.a
                    );
                }


                if (
                    x.b !==
                    y.b
                ) {

                    return (
                        x.b -
                        y.b
                    );
                }


                return (
                    x.c -
                    y.c
                );
            }
        );


        return {

            owner:
                best,

            lessons
        };
    }


    function coordinatorDeriveCurrent() {

        const directory =
            coordinatorGetDirectory();


        if (
            !directory
        ) {

            return null;
        }


        const lessons =
            directory.lessons;


        let bestMatch =
            null;


        for (
            const entry
            of registry.values()
        ) {

            for (
                const candidate
                of entry.titles
            ) {

                const candidateText =
                    normalize(
                        candidate.text
                    );


                if (
                    !candidateText
                ) {

                    continue;
                }


                for (
                    let i = 0;
                    i <
                    lessons.length;
                    i++
                ) {

                    const lesson =
                        lessons[i];


                    const lessonTitle =
                        normalize(
                            lesson.title
                        );


                    let matchStrength =
                        0;


                    if (
                        candidateText ===
                        lessonTitle
                    ) {

                        matchStrength =
                            1000;

                    } else if (
                        candidate.fontSize >=
                            20 &&
                        (
                            candidateText.includes(
                                lessonTitle
                            ) ||
                            lessonTitle.includes(
                                candidateText
                            )
                        )
                    ) {

                        matchStrength =
                            300;

                    } else {

                        continue;
                    }


                    const totalScore =
                        matchStrength +
                        Number(
                            candidate.score ||
                            0
                        );


                    if (
                        !bestMatch ||
                        totalScore >
                            bestMatch.totalScore
                    ) {

                        bestMatch = {

                            ...lesson,

                            index:
                                i,

                            lessons,

                            owner:
                                directory.owner,

                            matchedTitle:
                                candidateText,

                            totalScore
                        };
                    }
                }
            }
        }


        return bestMatch;
    }


    function coordinatorBroadcast(
        message
    ) {

        coordinatorPrune();


        for (
            const entry
            of registry.values()
        ) {

            try {

                entry.source
                    .postMessage(
                        message,
                        '*'
                    );

            } catch (e) {}
        }
    }


    // ============================================================
    // 12. 新课程自动播放
    // ============================================================

    function coordinatorStartPlay(
        lesson
    ) {

        autoPlayTargetKey =
            lesson.key;


        /*
         * 后台标签页可能降频，
         * 因此保留 5 分钟自动播放窗口。
         */
        autoPlayDeadline =
            Date.now() +
            300000;


        const delays = [

            200,

            500,

            900,

            1500,

            2500,

            4000,

            6000,

            9000,

            12000,

            16000
        ];


        for (
            const delay
            of delays
        ) {

            setTimeout(
                () => {

                    const current =
                        coordinatorDeriveCurrent();


                    if (
                        !current ||
                        current.key !==
                            lesson.key
                    ) {

                        return;
                    }


                    coordinatorBroadcast(
                        {

                            type:

                                'CX22_CONTEXT',

                            lessonKey:

                                lesson.key,

                            lessonTitle:

                                lesson.title
                        }
                    );


                    coordinatorBroadcast(
                        {

                            type:

                                'CX22_PLAY',

                            lessonKey:

                                lesson.key,

                            lessonTitle:

                                lesson.title
                        }
                    );

                },
                delay
            );
        }
    }


    function coordinatorWaitForLesson(
        key
    ) {

        return new Promise(
            resolve => {

                const started =
                    Date.now();


                const timer =
                    setInterval(
                        () => {

                            const current =
                                coordinatorDeriveCurrent();


                            if (
                                current &&
                                current.key ===
                                    key
                            ) {

                                clearInterval(
                                    timer
                                );


                                resolve(
                                    true
                                );


                                return;
                            }


                            if (
                                Date.now() -
                                    started >
                                15000
                            ) {

                                clearInterval(
                                    timer
                                );


                                resolve(
                                    false
                                );
                            }

                        },
                        250
                    );
            }
        );
    }


    // ============================================================
    // 13. 视频结束 -> 下一条三级课程
    // ============================================================

    async function coordinatorHandleEnded(
        message
    ) {

        if (
            coordinatorSwitching
        ) {

            log(
                '协调器：正在切课，忽略重复 ended'
            );


            return;
        }


        const current =
            coordinatorDeriveCurrent();


        if (
            !current
        ) {

            const directory =
                coordinatorGetDirectory();


            const titleCandidates =
                [];


            for (
                const entry
                of registry.values()
            ) {

                for (
                    const candidate
                    of entry.titles
                ) {

                    titleCandidates
                        .push(
                            candidate.text
                        );
                }
            }


            log(
                '协调器：无法对应当前课程。',
                '三级课程数量 =',
                directory
                    ? directory.lessons.length
                    : 0,
                '标题候选前10 =',
                titleCandidates.slice(
                    0,
                    10
                )
            );


            return;
        }


        if (
            message.lessonKey &&
            message.lessonKey !==
                current.key
        ) {

            log(
                '协调器：忽略旧播放器 ended',
                message.lessonKey,
                '当前页面 =',
                current.key
            );


            return;
        }


        const next =
            current.lessons[
                current.index +
                1
            ];


        if (
            !next
        ) {

            log(
                '协调器：已经是最后一条三级课程'
            );


            return;
        }


        coordinatorSwitching =
            true;


        log(
            '当前左上角课名：',
            current.matchedTitle
        );


        log(
            '匹配到当前三级课：',
            current.text
        );


        log(
            '严格下一条三级课：',
            next.text
        );


        try {

            current.owner
                .source
                .postMessage(
                    {

                        type:

                            'CX22_CLICK',

                        lessonKey:

                            next.key
                    },
                    '*'
                );

        } catch (e) {

            coordinatorSwitching =
                false;


            return;
        }


        const changed =
            await coordinatorWaitForLesson(
                next.key
            );


        if (
            !changed
        ) {

            log(
                '协调器：点击后 15 秒仍未识别到下一课标题'
            );


            coordinatorSwitching =
                false;


            return;
        }


        log(
            '协调器：确认已经进入：',
            next.text
        );


        coordinatorSwitching =
            false;


        coordinatorBroadcast(
            {

                type:

                    'CX22_CONTEXT',

                lessonKey:

                    next.key,

                lessonTitle:

                    next.title
            }
        );


        coordinatorStartPlay(
            next
        );
    }


    // ============================================================
    // 14. iframe 消息处理
    // ============================================================

    window.addEventListener(
        'message',
        event => {

            if (
                !event.data ||
                typeof event.data !==
                    'object'
            ) {

                return;
            }


            const data =
                event.data;

            // 只接受顶层协调器发来的全局题目锁。
            if (data.type === 'CX22_QUIZ_LOCK') {
                if (event.source === window.top) {
                    setQuizLock(!!data.active);
                }
                return;
            }


            // ----------------------------------------------------
            // 判断题状态
            // ----------------------------------------------------

            if (
                window ===
                    window.top &&
                data.type ===
                    'CX22_QUIZ_STATE'
            ) {

                coordinatorSetQuizState(
                    data.frameId,
                    !!data.active
                );


                return;
            }


            // ----------------------------------------------------
            // 当前课程
            // ----------------------------------------------------

            if (
                data.type ===
                'CX22_CONTEXT'
            ) {

                activeLessonKey =
                    data.lessonKey ||
                    '';


                activeLessonTitle =
                    data.lessonTitle ||
                    '';


                document
                    .querySelectorAll(
                        'video'
                    )
                    .forEach(
                        video => {

                            if (
                                !video.ended &&
                                !video.dataset
                                    .cx22LessonKey
                            ) {

                                video.dataset
                                    .cx22LessonKey =
                                    activeLessonKey;
                            }
                        }
                    );


                return;
            }


            // ----------------------------------------------------
            // 播放
            // ----------------------------------------------------

            if (
                data.type ===
                'CX22_PLAY'
            ) {

                activeLessonKey =
                    data.lessonKey ||
                    activeLessonKey;


                activeLessonTitle =
                    data.lessonTitle ||
                    activeLessonTitle;


                tryPlayLocal();


                return;
            }


            // ----------------------------------------------------
            // 点击下一课
            // ----------------------------------------------------

            if (
                data.type ===
                'CX22_CLICK'
            ) {

                const clicked =
                    clickLocalLesson(
                        data.lessonKey
                    );


                if (
                    clicked
                ) {

                    try {

                        window.top
                            .postMessage(
                                {

                                    type:

                                        'CX22_CLICK_ACK',

                                    frameId:

                                        FRAME_ID,

                                    lessonKey:

                                        data.lessonKey
                                },
                                '*'
                            );

                    } catch (e) {}
                }


                return;
            }


            // ----------------------------------------------------
            // 顶层协调器
            // ----------------------------------------------------

            if (
                window ===
                window.top
            ) {

                if (
                    data.type ===
                    'CX22_STATE'
                ) {

                    coordinatorReceiveState(
                        event.source,
                        data
                    );


                    return;
                }


                if (
                    data.type ===
                    'CX22_ENDED'
                ) {

                    coordinatorHandleEnded(
                        data
                    );


                    return;
                }


                if (
                    data.type ===
                    'CX22_CLICK_ACK'
                ) {

                    log(
                        '目录 frame 已执行点击：',
                        data.lessonKey
                    );
                }
            }
        }
    );


    // ============================================================
    // 15. 视频扫描
    // ============================================================

    function scanVideos() {

        document
            .querySelectorAll(
                'video'
            )
            .forEach(
                video => {

                    muteVideo(
                        video
                    );


                    bindVideo(
                        video
                    );


                    bindBackgroundVideo(
                        video
                    );
                }
            );
    }


    // ============================================================
    // 16. 启动
    // ============================================================

    function start() {

        log(
            'v22.4 启动',

            window ===
                window.top
                ? '【顶层协调器】'
                : '【iframe】'
        );


        scanVideos();


        scanBackgroundVideos();


        sendState();


        const observer =
            new MutationObserver(
                () => {

                    scanVideos();


                    scanBackgroundVideos();


                    clearTimeout(
                        observer._timer
                    );


                    observer._timer =
                        setTimeout(
                            sendState,
                            150
                        );
                }
            );


        observer.observe(
            document.documentElement,
            {

                childList:
                    true,

                subtree:
                    true
            }
        );


        setInterval(
            () => {

                scanVideos();


                sendState();

            },
            700
        );


        startBackgroundGuard();


        startVideoQuizAlert();
    }


    if (
        document.readyState ===
        'loading'
    ) {

        document.addEventListener(
            'DOMContentLoaded',
            start
        );

    } else {

        start();
    }

})();
