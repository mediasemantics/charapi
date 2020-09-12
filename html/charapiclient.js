'use strict';
(function(lib, $) {
    lib.instances = {};

    // Init/cleanup api attaches a character to a div
    lib.setupDiv = function(divid, params) {
        lib.cleanupDiv(divid);
        lib.instances[divid] = new CharApiClient(divid, params);
        return lib.instances[divid];
    }
    lib.cleanupDiv = function(divid) {
        var that = lib.instances[divid];
        if (that) {
            that.cleanup();
            delete lib.instances[divid];
        }
    }

    // Support, but don't require, jquery
    if (window.$) {
        $.fn.charapiclient = function (args) {
            if (!this[0]) return console.log("charapiclient unknown div");
            if (!this[0].id) return console.log("charapiclient div must have an id");
            if (typeof arguments[0] === 'object') {
                var settings = $.extend({}, arguments[0]);
                lib.setupDiv(this[0].id, settings.userid, settings.moduleid, settings);
            }
            else {
                var instance = lib.instances[this[0].id];
                switch (arguments[0]) {
                    case "playing":  // playing state - i.e. not idle
                        return instance.playing();
                    case "dynamicPlay":
                        return instance.dynamicPlay(arguments[1], arguments[2], arguments[3]);
                    case "preloadDynamicPlay":
                        return instance.preloadDynamicPlay(arguments[1], arguments[2], arguments[3]);
                    case "stop":
                        return instance.stop();
                    case "cleanup":
                        return lib.cleanupDiv(this[0].id);
                    default:
                        console.log("charapiclient unknown command " + arguments[0]);
                }
            }
        }
    }

    window.AudioContext = window.AudioContext || window.webkitAudioContext;

})(CharApiClient = CharApiClient||{}, window["jQuery"]);
var CharApiClient;

function CharApiClient(divid, params) {
    var that = this;
    if (!params.endpoint) console.log("missing parameter endpoint");

    var version;
    var messageid;
    var fade = true;            // Whether we fade-in the opening scene - true by default but can be overridden in params
    var playQueue = [];         // Queue of [0,id,line] or [1,{do,say,audio,...}]
    var playCur = null;         // Currently playing playQueue item, or null
    var playShield = false;     // true if play shield is up
    var idleType = "normal";
    var bobType = "normal";
    var saveState = false;

    function resetOuterVars() {
        fade = true;
        playQueue = [];
        playCur = null;
        playShield = false;
        idleType = "normal";
        bobType = "normal";
        saveState = false;
    }

    function start() {
        // autoplay

        if (params.autoplay) { // IF we asked for autoplay AND we are autoplay-disabled, show play shield
            if (audioContext && audioContext.state == "suspended" ||
                navigator.userAgent.match(/iPhone/i) ||
                navigator.userAgent.match(/iPad/i) ||
                navigator.userAgent.match(/android/i))
                playShield = true;
        }

        if (typeof params.preload === "boolean") preload = params.preload;
        if (typeof params.fade === "boolean") fade = params.fade;
        if (typeof params.playShield === "boolean") playShield = params.playShield; // effectively forces autoplay
        if (typeof params.idleType === "string") idleType = params.idleType; // "none"/"blink"/"normal"
        if (typeof params.bobType === "string") bobType = params.bobType; // "none"/"always"/"normal"
        if (typeof params.saveState === "boolean") saveState = params.saveState; // initial state of 2nd dynamicPlay is the final state of the previous one

        if (bobType == "always") bob = true;

        setupScene();
        if (playShield) setupPlayShield(params.width, params.height);
        setupCharacter();
    }

    function setupScene() {
        var div = document.getElementById(divid);
        var cx = params.width;
        var cy = params.height;
        var scale = !isVector() ? ((params.characterScale||100)/100).toFixed(2) : 1;
        var cxMax = cx;
        var cyMax = cy;
        var cxMax2 = cxMax * scale;
        var cyMax2 = cyMax * scale;
        var s = '';
        s += '<div id="' + divid + '-top' + '" style="visibility:hidden; width:' + cx + 'px; height:' + cy + 'px; position:relative; overflow: hidden;">';
        s += '  <canvas id="' + divid + '-canvas" width="' + cxMax + '" height="' + cyMax + '" style="position:absolute; top:0px; left:0px; width:' + cxMax2 + 'px; height:' + cyMax2 + 'px; "></canvas>';
        if (playShield)
            s += '  <canvas id="' + divid + '-playshield-canvas" style="position:absolute; left:0px; top:0px;" width="' + cx +'px" height="' + cy + 'px"/></canvas>';
        if (!audioContext)
            s += '  <audio id="' + divid + "-audio" + '"></audio>';
        s += '</div>'
        div.innerHTML = s;
    }

    function setupCharacter() {
        execute("", "", null, null, null); // first load results in characterLoaded
    }

    function characterLoaded() {
        var topDiv = document.getElementById(divid + "-top");
        topDiv.style.visibility = "visible";

        // NOTE: dispatched as soon as we become visible (we become visible all at once) - client could immediately set to an alpha of 0 and fade in over time with their own fade, or whatever
        document.getElementById(divid).dispatchEvent(createEvent("characterLoaded"));

        if (fade)
            fadeIn(topDiv, 400, sceneFullyFadedIn);
        else
            sceneFullyFadedIn();
    }

    function sceneFullyFadedIn() {
        startIdle();
        if (!playShield) playAutoStart();
    }

    function onPlayShieldClick() {
        var e = document.getElementById(divid + "-playshield-canvas")
        if (e) e.style.display = "none";
        playAutoStart();
    }

    function playAutoStart() {
        // Just an event that is called either when the character is loaded, if possible, or when the play shield is clicked, if not. Client can now call play().
        document.getElementById(divid).dispatchEvent(createEvent("autoStart"));
    }

    this.playing = function() {
        return !!playCur;
    };

    this.playShield = function() {
        return !!playShield;
    };

    this.playQueueLength = function() {
        return playQueue.length;
    };

    this.dynamicPlay = function(o) {
        if (audioContext) audioContext.resume();
        if (o) {
            // Process the object
            if (typeof o.say == "number") o.say = o.say.toString();
            else if (typeof o.say != "string") o.say = "";
            if (!loading && !animating) {
                playCur = o;
                execute(o.do, o.say, o.audio, o.lipsync, onPlayDone);
            }
            else {
                if (!playCur && playQueue.length == 0)
                    stopAll(); // accelerate any running idle when we begin to play
                playQueue.push(o);
                // All queued messages are preload candidates
                preloadExecute(o.do, o.say, o.audio, o.lipsync);
            }
        }
        else document.getElementById(divid).dispatchEvent(createEvent("playComplete")); // always get one of these
    }

    // Like dynamicPlay, but merely attempts to preload all the files required
    this.preloadDynamicPlay = function(o) {
        if (o) {
            if (typeof o.say == "number") o.say = o.say.toString();
            else if (typeof o.say != "string") o.say = "";
            o.say = o.say.substr(0, 255);
            preloadExecute(o.do, o.say, o.audio, o.lipsync);
        }
    }

    function onPlayDone() {
        if (playQueue.length > 0) {
            playCur = playQueue.shift();
            execute(playCur.do, playCur.say, playCur.audio, playCur.lipsync, onPlayDone);
            document.getElementById(divid).dispatchEvent(createEvent("playQueueLengthDecreased"));
        }
        else {
            if (playCur) { // we also get here onIdleComplete
                playCur = null;
                document.getElementById(divid).dispatchEvent(createEvent("playComplete")); // i.e. all plays complete - we are idle
            }
        }
    }

    function onIdleComplete() {
        // if a play happens while running an idle automation, we just queue it up
        onPlayDone();
    }

    this.stop = function() {
        stopAll();
        playQueue = [];
    }

    function onEmbeddedCommand(cmd) {
        // Note that type 'apogee' commands are used in Character Builder to implement the "and" feature
        var e = new CustomEvent("embeddedCommand", {detail: cmd});  // access via e.detail in your event handler
        if (!e) e = createEvent("embeddedCommand"); // TODO investigate if IE supports event detail
        document.getElementById(divid).dispatchEvent(e);
    }

    function makeGetURL(addedParams) { // addedParams starts with & if truthy
        // Caller-supplied endpoint
        var url = params.endpoint;
        // Additional parameters from the caller, e.g. character
        for (var key in params) {
            if (key && key != "endpoint" && key != "fade" && key != "idleType" && key != "bobType" && key != "autoplay" && key != "playShield" && key != "preload" && key != "saveState") // minus the parameters for charapiclient
                url += (url.indexOf("?") == -1 ? "?" : "&") + key + "=" + encodeURIComponent(params[key]);
        }
        // Additional params added by charapiclient.js, e.g. texture, with
        if (addedParams) url += (url.indexOf("?") == -1 ? "?" : "&") + addedParams.substr(1);
        return url;
    }

    // Audio - only one speaking animation occurs at a time
    var audioContext = AudioContext ? new AudioContext() : null;
    var gainNode = null;
    if (audioContext) {
        gainNode = audioContext.createGain();
        gainNode.gain.value = 1;
        gainNode.connect(audioContext.destination);
    }
    var audioBuffer;                     // Audio buffer being loaded
    var audioSource;                     // Audio source, per character

    // State
    var initialState = "";

    // Loading
    var texture;                      // Latest loaded texture - we try to keep it down to eyes, mouth - the leftovers
    var animData;                     // animData to match texture.
    var secondaryTextures = {};       // e.g. {LookDownLeft:Texture}
    var defaultTexture;               // The initial texture is also the secondary texture named 'default'

    // Running
    var loaded;                     // True if default frame is loaded for a given character
    var loading;                    // True if we are loading a new animation - does not overlap animating
    var animating;                  // True if a character is animating
    var startTime;                  // Time when a character's animation started
    var frame;                      // Current frame of animation
    var stopping;                   // True if we are stopping an animation - overlaps animating
    var recovery;                   // A {frame, time} object if recovering from a stop
    var executeCallback;            // What to call on execute() return, i.e. when entire animation is complete
    var rafid;                      // Defined only when at least one character is animating - otherwise we stop the RAF (game) loop

    // Idle
    var idleTimeout;
    var timeSinceLastIdleCheck;
    var timeSinceLastAction;       // Time since any action, reset on end of a message - drives idle priority
    var timeSinceLastBlink;        // Similar but only for blink
    var randomRightLoaded = false;      // Drive bob
    var bob = false;                    // True if both head bob tracks are loaded by idle - tells the server to include it in messages
    var lastIdle = "";                  // Avoid repeating an idle, etc.

    // Settle feature
    var timeSinceLastAudioStopped = 0;   // Used to detect if and how much we should settle for
    var settleTimeout;              // If non-0, we are animating true but are delaying slightly at the beginning to prevent back-to-back audio

    // Preloading
    var preload = true;         // Master switch (a param normally)
    var preloaded = [];         // list of things we already pulled on
    var preloadQueue = [];      // de-duped list of urls to pull on
    var preloading = false;     // url being preloaded
    var preloadTimeout = null;  // defined if a preload timeout is outstanding

    function resetInnerVars() {
        gainNode = null;
        audioBuffer = null;
        audioSource = undefined;

        initialState = "";

        texture = undefined;
        animData = undefined;
        secondaryTextures = {};
        defaultTexture = undefined;

        loaded = undefined;
        loading = undefined;
        animating = undefined;
        startTime = undefined;
        frame = undefined;
        stopping = undefined;
        recovery = undefined;
        executeCallback = undefined;
        idleTimeout = null;
        rafid = null;

        idleTimeout = null;
        timeSinceLastIdleCheck = 0;
        timeSinceLastAction = undefined;
        timeSinceLastBlink = undefined;
        randomRightLoaded = false;
        bob = false;
        lastIdle = "";

        timeSinceLastAudioStopped = 0;
        settleTimeout = undefined;

        preload = true;
        preloaded = [];
        preloadQueue = [];
        preloading = false;
        preloadTimeout = null;
    }

    function execute(tag, say, audio, lipsync, callback) {
        if (loading || animating) {
            console.log("internal error"); // execute called on a character while animating that character
            return;
        }

        executeCallback = callback;

        stopping = false;
        recovery = null;
        loading = true;
        animating = false;

        var addedParams = "";

        var action = "";
        secondaryTextures = {};
        if (tag || say) {
            setRandomSeed(say);
            if (saveState) addedParams += "&initialstate=" + initialState;
            var actionTemplate = getActionTemplateFromTag(tag, params.character);
            var action = getActionFromActionTemplate(actionTemplate, say, audio, bob);
            addedParams = addedParams + '&action=' + encodeURIComponent(action);
            addedParams = addedParams + '&with=all';
        }

        if (say && audio && lipsync)
            speakRecorded(addedParams, audio, lipsync);
        else if (say)
            speakTTS(addedParams);
        else
            loadAnimation(addedParams, false);
    }

    function speakRecorded(params, audioURL, lipsync) {
        params = params + '&lipsync=' +  encodeURIComponent(lipsync);
        // load the audio, but hold it
        if (audioContext) { // Normal case
            var xhr = new XMLHttpRequest();
            xhr.open('GET', audioURL, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function () {
                audioContext.decodeAudioData(xhr.response, function (buffer) {
                    audioBuffer = buffer;
                    loadAnimation(params, true);
                });
            };
            xhr.send();
        }
        else { // IE only
            var audio = document.getElementById(divid + "-audio");
            audio.oncanplaythrough = function() {
                audio.pause();
                loadAnimation(params, true);
            };
            audio.src = audioURL;
        }

        if (audioURL && preloaded.indexOf(audioURL) == -1) preloaded.push(audioURL);
    }

    function speakTTS(addedParams) {
        var audioURL = makeGetURL(addedParams + "&type=audio");
        if (audioContext) { // Normal case - only IE does not support web audio
            var xhr = new XMLHttpRequest();
            xhr.open('GET', audioURL, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function () {
                audioContext.decodeAudioData(xhr.response, function (buffer) {
                    audioBuffer = buffer;
                    if (preloaded.indexOf(audioURL) == -1) preloaded.push(audioURL);
                    loadAnimation(addedParams, true);
                });
            };
            xhr.send();
        }
        else { // IE only
            var audio = document.getElementById(divid + "-audio");
            audio.oncanplaythrough = function() {
                audio.pause();
                if (preloaded.indexOf(audioURL) == -1) preloaded.push(audioURL);
                loadAnimation(addedParams, true);
            };
            audio.src = audioURL;
        }
    }

    function loadAnimation(addedParams, startAudio) {
        var dataURL = makeGetURL(addedParams + "&type=data");
        // Load the data
        var xhr = new XMLHttpRequest();
        xhr.open('GET', dataURL, true);
        xhr.onload = function () {
            animData = JSON.parse(xhr.response);
            if (preloaded.indexOf(dataURL) == -1) preloaded.push(dataURL);
            // Record the textures we'll need
            secondaryTextures = {};
            for (var i = 0; i < animData.textures.length; i++) {
                if (animData.textures[i] != "default")
                    secondaryTextures[animData.textures[i]] = null;
            }
            // Load the image
            var imageURL = makeGetURL(addedParams + "&type=image");
            texture = new Image();
            texture.crossOrigin = "Anonymous";
            texture.onload = function() {
                if (preloaded.indexOf(imageURL) == -1) preloaded.push(imageURL);
                loadSecondaryTextures(startAudio);
            };
            texture.src = imageURL;
        }
        xhr.send();
    }

    function loadSecondaryTextures(startAudio) {
        var allLoaded = true;
        var key;
        for (key in secondaryTextures)
            if (secondaryTextures[key] === null) {allLoaded = false; break;}
        if (allLoaded) {
            getItStarted(startAudio)
        }
        else {
            // key is next texture to load
            var textureURL = makeGetURL("&texture=" + key + "&type=image");
            secondaryTextures[key] = new Image();
            secondaryTextures[key].crossOrigin = "Anonymous";
            secondaryTextures[key].onload = function () {
                if (textureURL && preloaded.indexOf(textureURL) == -1) preloaded.push(textureURL);
                // keep special track of this texture when it is loaded
                if (key.indexOf("RandomRight") != -1)
                    randomRightLoaded = true;
                if (randomRightLoaded && bobType != "none")
                    bob = true;
                // load some more
                loadSecondaryTextures(startAudio);
            };
            secondaryTextures[key].src = textureURL;
        }
    }

    // just fire and forget at any time, as if you were running execute
    function preloadExecute(tag, say, audio, lipsync) {
        var addedParams = "";
        setRandomSeed(say);
        if (saveState) addedParams += "&initialstate=" + initialState;
        var actionTemplate = getActionTemplateFromTag(tag, params.character);
        var action = getActionFromActionTemplate(actionTemplate, say, audio, bob);
        addedParams = addedParams + '&action=' + encodeURIComponent(action);
        addedParams = addedParams + '&with=all';
        if (say && audio && lipsync) {
            addedParams = addedParams + '&lipsync=' +  encodeURIComponent(lipsync);
        }
        if (say && !audio) {
            var audioURL = makeGetURL(addedParams + "&type=audio");
            preloadHelper(audioURL);
        }
        var imageURL = makeGetURL(addedParams + "&type=image");
        preloadHelper(imageURL);
        var dataURL = makeGetURL(addedParams + "&type=data");
        preloadHelper(dataURL);
    }

    function preloadHelper(url) {
        if (preloaded.indexOf(url) == -1 && preloadQueue.indexOf(url) == -1)
            preloadQueue.push(url);
    }

    function preloadSomeMore() {
        preloadTimeout = null;
        if (preloading || preloadQueue.length == 0) return;
        preloading = preloadQueue.shift();
        //console.log("preloading "+preloading)
        var xhr = new XMLHttpRequest();
        xhr.open("GET", preloading, true);
        xhr.addEventListener("load", function() {
            preloaded.push(preloading);
            // if this was animation data, then also find secondary textures
            if (preloading.indexOf("&type=data") != -1) {
                var animDataPreload = JSON.parse(xhr.response);
                for (var i = 0; i < animDataPreload.textures.length; i++) {
                    if (animDataPreload.textures[i] != "default")
                        preloadHelper(makeGetURL("&texture=" + animDataPreload.textures[i] + "&type=image"));
                }
            }
            preloading = null;
            // restart in a bit
            if (preloadQueue.length > 0)
                preloadTimeout = setTimeout(preloadSomeMore, 500);
        });
        xhr.send();
    }

    function getItStarted(startAudio) {
        // render the first frame and start animation loop
        loading = false;
        animating = true;

        // Settling feature - establish a minimum time between successive animations - mostly to prevent back to back audio - because we are so good at preloading
        if (settleTimeout) {clearTimeout(settleTimeout); settleTimeout = 0;}
        var t = Date.now();
        if (t - timeSinceLastAudioStopped < 333) {
            settleTimeout = setTimeout(onSettleComplete.bind(null, startAudio), 333 - (t - timeSinceLastAudioStopped));
        }
        else {
            getItStartedActual(startAudio);
        }
    }

    function onSettleComplete(startAudio) {
        settleTimeout = 0;
        getItStartedActual(startAudio);
    }

    function getItStartedActual(startAudio) {
        // start animation loop
        if (!rafid) rafid = requestAnimationFrame(animate);
        // start audio
        if (startAudio) {
            if (audioContext) {
                audioSource = audioContext.createBufferSource();
                audioSource.buffer = audioBuffer;
                audioSource.connect(gainNode);
                gainNode.gain.value = 1;
                audioSource.start();
            }
            else {
                var audio = document.getElementById(divid + "-audio");   // for use with playAudio
                audio.play();
            }
            // you can use this event to start playing audio, if you are managing audio externally
            document.getElementById(divid).dispatchEvent(createEvent("playStarted"));
        }
        // simple strategy - when there is stuff to preload, slip one in every second or so - rarely does it lock up load channels for actual loads
        if (!preloadTimeout && preload)
            preloadTimeout = setTimeout(preloadSomeMore, 500);
    }

    function animate(timestamp) {
        rafid = undefined;
        var raf = false;
        var completed = undefined;
        if (animData && animating) {
            if (!startTime)
                startTime = timestamp;

            // exit case
            if (frame == -1)
            {
                completed = true;
            }
            else {

                var frameNew;
                if (!recovery) {
                    // normal case - estimate frame based on fps and time from the beginning
                    var progress = timestamp - startTime;
                    frameNew = Math.floor(progress / 1000 * animData.fps);
                }
                else {
                    // recovering from a stop
                    var progress = timestamp - recovery.time;
                    frameNew = recovery.frame + Math.floor(progress / 1000 * animData.fps);
                }

                if (frameNew == frame) {
                    raf = true;
                }
                else {
                    frame = frameNew;
                    if (frame >= animData.frames.length)
                    {
                        completed = true;
                    }
                    else {
                        raf = true;

                        // first arg is the image frame to show
                        var framerec = animData.frames[frame];
                        if (!framerec) {
                            console.log("Character API Client internal error at "+frame);
                            return;
                        }

                        var canvas = document.getElementById(divid + "-canvas");
                        if (canvas) {
                            var ctx = canvas.getContext("2d");
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            if (animData.recipes) {
                                var recipe = animData.recipes[framerec[0]];
                                for (var i = 0; i < recipe.length; i++) {
                                    var key = recipe[i][6];
                                    if (typeof key == "number") key = animData.textures[key];
                                    var src, off = {x:0, y:0};
                                    if (key == 'default' && defaultTexture)
                                        src = defaultTexture;
                                    else if (secondaryTextures && secondaryTextures[key])
                                        src = secondaryTextures[key];
                                    else
                                        src = texture;
                                    var png = (params.format == "png" || animData.layered);
                                    if (png) {
                                        if (!animData.layered) {
                                            ctx.clearRect(
                                                recipe[i][0], recipe[i][1],
                                                recipe[i][4], recipe[i][5]
                                            );
                                        }
                                        ctx.drawImage(src,
                                            recipe[i][2] + off.x, recipe[i][3] + off.y,
                                            recipe[i][4], recipe[i][5],
                                            recipe[i][0], recipe[i][1],
                                            recipe[i][4], recipe[i][5]);
                                    }
                                    else {
                                        var buf = i > 1 ? 1 : 0; // jpeg edges are fuzzy
                                        ctx.drawImage(src,
                                            recipe[i][2] + off.x + buf, recipe[i][3] + off.y + buf,
                                            recipe[i][4] - buf*2, recipe[i][5] - buf * 2,
                                            recipe[i][0] + buf, recipe[i][1] + buf,
                                            recipe[i][4] - buf*2, recipe[i][5] - buf*2);
                                    }
                                }
                            }
                            else {
                                ctx.drawImage(texture, 0, 0, params.width, params.height, 0, 0, params.width, params.height);
                            }

                            // third arg is an extensible side-effect string that is triggered when a given frame is reached
                            if (animData.frames[frame][2])
                                onEmbeddedCommand(animData.frames[frame][2]);
                            // second arg is -1 if this is the last frame to show, or a recovery frame to go to if stopping early
                            var recoveryFrame = animData.frames[frame][1];
                            if (recoveryFrame == -1)
                                frame = -1;
                            else if (stopping && recoveryFrame)
                                recovery = {frame:recoveryFrame, time:timestamp};
                        }
                    }
                }
            }
        }
        if (raf) rafid = requestAnimationFrame(animate);
        if (completed) {
            animating = false;
            stopping = false;
            recovery = null;
            startTime = undefined;
            frame = undefined;
            animateComplete();
        }
    }

    function stopAll() {
        if (audioContext) {
            gainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
            timeSinceLastAudioStopped = Date.now();
        }
        else {
            var audio = document.getElementById(divid + "-audio");
            if (audio) audio.pause();
        }
        if (loading || animating)
            stopping = true;
        if (settleTimeout) {
            clearTimeout(settleTimeout);
            settleTimeout = 0;
            animating = false;
            animateComplete();
        }
    }

    function animateComplete() {
        timeSinceLastAction = 0;  // used in checkIdle

        if (!loaded) {
            loaded = true;

            // Pick up initial default texture if we are loading character for the first time
            if (!defaultTexture && texture && animData && animData.recipes)
                defaultTexture = texture;

            timeSinceLastBlink = 0;

            characterLoaded();
        }
        else {
            if (audioSource) {
                audioSource = null;
                timeSinceLastAudioStopped = Date.now();
            }
            if (params.saveState) initialState = animData.finalState;
            if (executeCallback) {
                var t = executeCallback;
                executeCallback = null;
                if (t) t();
            }
        }
    }

    function isVector() {
        var style = characterObject(params.character).style;
        return style.split("-")[0] == "illustrated" || style == "cs" || style == "classic";
    }

    function getIdlesFromStyle(style) {
        // Because we are not loading env.json
        var styleMajor = style.split("-")[0];
        if (styleMajor == "realistic" || styleMajor == "cgi" /*|| styleMajor == "illustrated"*/) {
            var a = [];
            for (var i = 1; i <= 3; i++)
                a.push("headidle"+i);
            var styleMinor = style.split("-")[1];
            if (styleMinor == "body" || styleMinor == "bust")
            for (i = 1; i <= 3; i++)
                a.push("bodyidle1"); // equally likely
            return a;
        }
        else return []; // never include blink
    }

    function supportsBob() {
        // used in standalone to force the issue
        var style = characterObject(params.character).style;
        var idles = getIdlesFromStyle(style);
        return (idles.indexOf("headidle1") != -1);
    }

    //
    // Idle
    //

    function startIdle() {
        if (!idleTimeout) idleTimeout = setTimeout(checkIdle, 1000)
    }

    function checkIdle() {
        // Called every second until cleanup
        var t = Date.now();
        var elapsed = t - (timeSinceLastIdleCheck||t);
        timeSinceLastIdleCheck = t;
        timeSinceLastAction += elapsed;
        timeSinceLastBlink += elapsed;

        if (loaded && !loading && !animating && !playShield) {
            if (timeSinceLastAction > 1500 + Math.random() * 3500) {  // no more than 5 seconds with no action whatsoever
                timeSinceLastAction = 0;
                // there will be action - will it be a blink? They must occur at a certain frequency.
                if (idleType != "none" && timeSinceLastBlink > 5000 + Math.random() * 5000) {
                    timeSinceLastBlink = 0;
                    execute("blink", "", null, null, onIdleComplete.bind(null));
                }
                // or another idle routine
                else if (idleType == "normal") {
                    var style = characterObject(params.character).style;
                    var idles = getIdlesFromStyle(style);
                    var headidle = (idles.indexOf("headidle1") != -1);
                    var idle = null;
                    // pick an idle that does not repeat - favor a headidle at first
                    if (idles.length > 0) {
                        for (var guard = 10; guard > 0; guard--) {
                            idle = idles[Math.floor(Math.random() * idles.length)];
                            if (idle == lastIdle) continue;
                            if (!lastIdle && idle.substr(0,8) != "headidle") continue;
                            break;
                        }
                    }
                    if (idle) {
                        lastIdle = idle;
                        execute(idle, "", null, null, onIdleComplete.bind(null));
                    }
                }
            }
        }
        idleTimeout = setTimeout(checkIdle, 1000);
    }


    //
    // Cleanup - all timers stopped, resources dropped, etc.
    //

    this.cleanup = function() {
        stopAll();
        if (idleTimeout) clearTimeout(idleTimeout);
        if (preloadTimeout) clearTimeout(preloadTimeout);
        if (rafid) cancelAnimationFrame(rafid);
        rafid = null;
        var div = document.getElementById(divid);
        if (div) div.innerHTML = "";
        resetInnerVars();
        resetOuterVars();
    }

    //
    // Fader
    //

    function fadeIn(elem, ms, fn)
    {
        elem.style.opacity = 0;
        elem.style.filter = "alpha(opacity=0)";
        elem.style.visibility = "visible";

        if (ms)
        {
            var opacity = 0;
            var timer = setInterval( function() {
                opacity += 50 / ms;
                if (opacity >= 1)
                {
                    clearInterval(timer);
                    opacity = 1;
                    if (fn) fn();
                }
                elem.style.opacity = opacity;
                elem.style.filter = "alpha(opacity=" + opacity * 100 + ")";
            }, 50 );
        }
        else
        {
            elem.style.opacity = 1;
            elem.style.filter = "alpha(opacity=1)";
        }
    }

    function fadeOut(elem, ms, fn)
    {
        if (ms)
        {
            var opacity = 1;
            var timer = setInterval(function() {
                opacity -= 50 / ms;
                if (opacity <= 0)
                {
                    clearInterval(timer);
                    opacity = 0;
                    elem.style.visibility = "hidden";
                    if (fn) fn();
                }
                elem.style.opacity = opacity;
                elem.style.filter = "alpha(opacity=" + opacity * 100 + ")";
            }, 50 );
        }
        else
        {
            elem.style.opacity = 0;
            elem.style.filter = "alpha(opacity=0)";
            elem.style.visibility = "hidden";
        }
    }

    //
    // Play Shield
    //

    function setupPlayShield(cx, cy)
    {
        var e = document.getElementById(divid + "-playshield-canvas")
        if (e)
        {
            // Background
            var ctx = e.getContext('2d');
            ctx.fillStyle= "#000000";
            ctx.globalAlpha=0.5;
            ctx.fillRect(0,0,cx,cy);

            var x = cx/2;
            var y = cy/2;

            // Inner
            ctx.beginPath();
            ctx.arc(x, y , 25, 0 , 2*Math.PI, false);
            ctx.fillStyle = "#999999";
            ctx.globalAlpha = 0.5;
            ctx.fill();

            // Outer
            ctx.beginPath();
            ctx.arc(x, y , 27, 0 , 2*Math.PI, false);
            ctx.strokeStyle = "#cccccc";
            ctx.lineWidth = 5;
            ctx.globalAlpha = 1;
            ctx.stroke();

            // Triangle
            ctx.beginPath();
            x -= 12; y -= 15;
            ctx.moveTo(x, y);
            y += 30;
            ctx.lineTo(x, y);
            y -= 15; x += 30;
            ctx.lineTo(x, y);
            y -= 15; x -= 30;
            ctx.lineTo(x, y);
            ctx.fillStyle = "#cccccc";
            ctx.globalAlpha = 1;
            ctx.fill();

            e.onclick = onPlayShieldClick;
        }
    }

    //
    // Misc
    //

    function createEvent(s) {
        if(typeof(Event) === 'function') {
            return new Event(s);
        }
        else {
            // For IE
            var event = document.createEvent('Event');
            event.initEvent(s, true, true);
            return event;
        }
    }

    var characterStyles = [
    {"id":"realistic-head", "name":"Realistic Head", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"realistic-bust", "name":"Realistic Bust", "naturalWidth":375, "naturalHeight":300, "recommendedWidth":275, "recommendedHeight":300, "recommendedX":-50, "recommendedY":0},
    {"id":"realistic-body", "name":"Realistic Body", "naturalWidth":500, "naturalHeight":400, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":-100, "recommendedY":0},
    {"id":"illustrated-head", "name":"Illustrated Head", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"illustrated-body", "name":"Illustrated Body", "naturalWidth": 307, "naturalHeight": 397, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"cs", "name":"Cartoon Solutions", "naturalWidth": 307, "naturalHeight": 397, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"classic", "name":"Classic Cartoon", "naturalWidth": 307, "naturalHeight": 397, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":0, "recommendedY":0},
    {"id":"cgi-head", "name":"CG Cartoon Head", "naturalWidth":250, "naturalHeight":200, "recommendedWidth":250, "recommendedHeight":200, "recommendedX":0, "recommendedY":0},
    {"id":"cgi-bust", "name":"CG Cartoon Bust", "naturalWidth":375, "naturalHeight":300, "recommendedWidth":275, "recommendedHeight":300, "recommendedX":-50, "recommendedY":0},
    {"id":"cgi-body", "name":"CG Cartoon Body", "naturalWidth":500, "naturalHeight":400, "recommendedWidth":300, "recommendedHeight":400, "recommendedX":-100, "recommendedY":0}
    ];

    var characters = [
    {"id":"SteveHead", "style":"realistic-head", "name":"Steve", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/SteveHead.gif"},
    {"id":"SusanHead", "style":"realistic-head", "name":"Susan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/SusanHead.gif"},
    {"id":"RobertHead", "style":"realistic-head", "name":"Robert", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/RobertHead.gif"},
    {"id":"AnnaHead", "style":"realistic-head", "name":"Anna", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/AnnaHead.gif"},
    {"id":"BenHead", "style":"realistic-head", "name":"Ben", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/BenHead.gif"},
    {"id":"AngelaHead", "style":"realistic-head", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.5", "thumb":"img/characters/AngelaHead.gif"},
    {"id":"GeneHead", "style":"realistic-head", "name":"Gene", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/GeneHead.gif"},
    {"id":"KateHead", "style":"realistic-head", "name":"Kate", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/KateHead.gif"},
    {"id":"LeeHead", "style":"realistic-head", "name":"Lee", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/LeeHead.gif"},
    {"id":"LilyHead", "style":"realistic-head", "name":"Lily", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/LilyHead.gif"},

    {"id":"CarlaHead", "style":"cgi-head", "name":"Carla", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/CarlaHead.gif"},
    {"id":"CarlHead", "style":"cgi-head", "name":"Carl", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.1", "thumb":"img/characters/CarlHead.gif"},

    {"id":"TomHead", "style":"illustrated-head", "format":"head", "name":"Tom", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/TomHead.gif"},
    {"id":"TashaHead", "style":"illustrated-head", "format":"head", "name":"Tasha", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/TashaHead.gif"},
    {"id":"RickHead", "style":"illustrated-head", "format":"head", "name":"Rick", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"2.2", "thumb":"img/characters/RickHead.gif"},
    {"id":"JimHead", "style":"illustrated-head", "format":"head", "name":"Jim", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/JimHead.gif"},
    {"id":"MeganHead", "style":"illustrated-head", "format":"head", "name":"Megan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/MeganHead.gif"},
    {"id":"KarmaJon", "style":"illustrated-head", "format":"head", "name":"Jon", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/Custom.gif", "tag":"karma"},

    {"id":"SteveBust", "style":"realistic-bust", "name":"Steve", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/SteveBust.gif"},
    {"id":"SusanBust", "style":"realistic-bust", "name":"Susan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/SusanBust.gif"},
    {"id":"RobertBust", "style":"realistic-bust", "name":"Robert", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/RobertBust.gif"},
    {"id":"AnnaBust", "style":"realistic-bust", "name":"Anna", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/AnnaBust.gif"},
    {"id":"BenBust", "style":"realistic-bust", "name":"Ben", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/BenBust.gif"},
    {"id":"AngelaBust", "style":"realistic-bust", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.5", "thumb":"img/characters/AngelaBust.gif"},
    {"id":"GeneBust", "style":"realistic-bust", "name":"Gene", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/GeneBust.gif"},
    {"id":"KateBust", "style":"realistic-bust", "name":"Kate", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/KateBust.gif"},
    {"id":"LeeBust", "style":"realistic-bust", "name":"Lee", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/LeeBust.gif"},
    {"id":"LilyBust", "style":"realistic-bust", "name":"Lily", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/LilyBust.gif"},

    {"id":"CarlaBust", "style":"cgi-bust", "name":"Carla", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/CarlaBust.gif"},
    {"id":"CarlBust", "style":"cgi-bust", "name":"Carl", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.1", "thumb":"img/characters/CarlBust.gif"},

    {"id":"SteveBody", "style":"realistic-body", "name":"Steve", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/SteveBody.gif"},
    {"id":"SusanBody", "style":"realistic-body", "name":"Susan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/SusanBody.gif"},
    {"id":"RobertBody", "style":"realistic-body", "name":"Robert", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/RobertBody.gif"},
    {"id":"AnnaBody", "style":"realistic-body", "name":"Anna", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/AnnaBody.gif"},
    {"id":"BenBody", "style":"realistic-body", "name":"Ben", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/BenBody.gif"},
    {"id":"AngelaBody", "style":"realistic-body", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.5", "thumb":"img/characters/AngelaBody.gif"},
    {"id":"GeneBody", "style":"realistic-body", "name":"Gene", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/GeneBody.gif"},
    {"id":"KateBody", "style":"realistic-body", "name":"Kate", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/KateBody.gif"},
    {"id":"LeeBody", "style":"realistic-body", "name":"Lee", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"3.0", "thumb":"img/characters/LeeBody.gif"},
    {"id":"LilyBody", "style":"realistic-body", "name":"Lily", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"3.0", "thumb":"img/characters/LilyBody.gif"},

    {"id":"CarlaBody", "style":"cgi-body", "name":"Carla", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.1", "thumb":"img/characters/CarlaBody.gif"},
    {"id":"CarlBody", "style":"cgi-body", "name":"Carl", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.1", "thumb":"img/characters/CarlBody.gif"},

    {"id":"TomBody", "style":"illustrated-body", "name":"Tom", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/TomBody.gif"},
    {"id":"TashaBody", "style":"illustrated-body", "name":"Tasha", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/TashaBody.gif"},
    {"id":"RickBody", "style":"illustrated-body", "name":"Rick", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"2.2", "thumb":"img/characters/RickBody.gif"},
    {"id":"JimBody", "style":"illustrated-body", "name":"Jim", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/JimBody.gif"},
    {"id":"MeganBody", "style":"illustrated-body", "name":"Megan", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/MeganBody.gif"},

    {"id":"CSDoug", "style":"cs", "name":"Doug", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSDoug.gif"},
    {"id":"CSDenise", "style":"cs", "name":"Denise", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSDenise.gif"},
    {"id":"CSPhil", "style":"cs", "name":"Phil", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSPhil.gif"},
    {"id":"CSSophia", "style":"cs", "name":"Sophia", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSSophia.gif"},
    {"id":"CSEmikoFront", "style":"cs", "name":"Emiko", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSEmikoFront.gif"},
    {"id":"CSRichardFront", "style":"cs", "name":"Richard", "gender":"male", "defaultVoice":"Joey", "version":"1.0", "thumb":"img/characters/CSRichardFront.gif"},
    {"id":"CSVeronicaFront", "style":"cs", "name":"Veronica", "gender":"female", "defaultVoice":"Salli", "version":"1.0", "thumb":"img/characters/CSVeronicaFront.gif"},
    {"id":"CSWyattFront", "style":"cs", "name":"Wyatt", "gender":"male", "defaultVoice":"Joey", "version":"1.0", "thumb":"img/characters/CSWyattFront.gif"},
    {"id":"CSSantaFront", "style":"cs", "name":"Santa", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSSantaFront.gif"},
    {"id":"CSFelixFoxFront", "style":"cs", "name":"Felix Fox", "gender":"male", "defaultVoice":"Joey", "version":"1.0", "thumb":"img/characters/CSFelixFoxFront.gif"},
    {"id":"CSAngela", "style":"cs", "name":"Angela", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.0", "thumb":"img/characters/CSAngela.gif"},
    {"id":"CSMaleek", "style":"cs", "name":"Maleek", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSMaleek.gif"},
    {"id":"CSDonaldTrump", "style":"cs", "name":"Donald Trump", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/CSDonaldTrump.gif"},

    {"id":"Brad", "style":"classic", "name":"Brad", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.2", "thumb":"img/characters/Brad.gif"},
    {"id":"Kim", "style":"classic", "name":"Kim", "gender":"female", "defaultVoice":"NeuralJoanna", "version":"1.2", "thumb":"img/characters/Kim.gif"},
    {"id":"Charlie", "style":"classic", "name":"Charlie", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/Charlie.gif"},
    {"id":"Al", "style":"classic", "name":"Al", "gender":"male", "defaultVoice":"NeuralMatthew", "version":"1.0", "thumb":"img/characters/Al.gif"},
    {"id":"Wolly", "style":"classic", "name":"Wolly", "gender":"male", "defaultVoice":"Joey", "version":"2.4", "thumb":"img/characters/Wolly.gif"}
    ]

    function characterObject(id) {
        for (var i = 0; i < characters.length ; i++)
            if (characters[i].id == id)
                return characters[i];
        return null;
    }

    function characterStyleObject(id) {
        for (var i = 0; i < characterStyles.length ; i++)
            if (characterStyles[i].id == id)
                return characterStyles[i];
        return null;
    }

    // This class supports a simplified model in which each Play can be associated with a specific action. The result is less flexible, but easier to work with.
    // This is the same model supported by the Character Builder Agent and Chatbot modules.

    var actions = [
        {"id":"look-up-right", "category":"look", "name":"Look Up Right", "xml":"<lookupleft/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-right", "category":"look", "name":"Look Right", "xml":"<lookleft/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-down-right", "category":"look", "name":"Look Down Right", "xml":"<lookdownleft/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-up", "category":"look", "name":"Look Up", "xml":"<lookup/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-down", "category":"look", "name":"Look Down", "xml":"<lookdown/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-up-left", "category":"look", "name":"Look Up Left", "xml":"<lookupright/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-left", "category":"look", "name":"Look Left", "xml":"<lookright/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-down-left", "category":"look", "name":"Look Down Left", "xml":"<lookdownright/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},

        {"id":"look-right", "category":"look-limited", "name":"Look Right", "xml":"<lookleft/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-up", "category":"look-limited", "name":"Look Up", "xml":"<lookup/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-down", "category":"look-limited", "name":"Look Down", "xml":"<lookdown/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"look-left", "category":"look-limited", "name":"Look Left", "xml":"<lookright/><cmd type='apogee'/>+{max:10}+<lookuser/>+{max:0,user:1}"},

        {"id":"gesture-right",   "category":"gesture", "name":"Gesture Right",      "xml":"<lookleft/><gestureleft/><cmd type='apogee'>+{max:10}+<lookuser/><handsbyside/>+{max:0,user:1}+{max:0,user:1}"},
        {"id":"gesture-left",      "category":"gesture", "name":"Gesture Left",     "xml":"<lookright/><gestureright/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},

        {"id":"point-up-right",   "category":"point", "name":"Point Up Right",      "xml":"<halfleft/><lookupleft/><pointupleft/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},
        {"id":"point-right",      "category":"point", "name":"Point Right",         "xml":"<halfleft/><lookleft/><pointleft/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},
        {"id":"point-down-right", "category":"point", "name":"Point Down Right",    "xml":"<halfleft/><lookdownleft/><pointdownleft/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},
        {"id":"point-up-left",    "category":"point", "name":"Point Up Left",       "xml":"<halfright/><lookupright/><pointupright/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},
        {"id":"point-left",       "category":"point", "name":"Point Left",          "xml":"<halfright/><lookright/><pointright/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},
        {"id":"point-down-left",  "category":"point", "name":"Point Down Left",     "xml":"<halfright/><lookdownright/><pointdownright/><cmd type='apogee'/>+{max:10}+<lookuser/><handsbyside/><front/>+{max:0,user:1}"},

        {"id":"point-up-right",   "category":"point-cs", "name":"Point Up Right",   "xml":"<pointupleft/><cmd type='apogee'/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"point-right",      "category":"point-cs", "name":"Point Right",      "xml":"<pointleft/><cmd type='apogee'/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"point-down-right", "category":"point-cs", "name":"Point Down Right", "xml":"<pointdownleft/><cmd type='apogee'/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"point-up-left",    "category":"point-cs", "name":"Point Up Left",    "xml":"<pointupright/><cmd type='apogee'/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"point-left",       "category":"point-cs", "name":"Point Left",       "xml":"<pointright/><cmd type='apogee'/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"point-down-left",  "category":"point-cs", "name":"Point Down Left",  "xml":"<pointdownright/><cmd type='apogee'/>+{max:10}+<handsbyside/>+{max:0,user:1}"},

        {"id":"eyes-wide", "category":"eyes", "name":"Eyes Wide", "xml":"<eyeswide/>+{max:10}+<eyesnormal/>+{max:0,user:1}"},
        {"id":"eyes-narrow", "category":"eyes", "name":"Eyes Narrow", "xml":"<eyesnarrow/>+{max:10}+<eyesnormal/>+{max:0,user:1}"},

        {"id":"head-nod", "category":"head", "name":"Head Nod", "xml":"<eyeswide/><headnod/><eyesnormal/>+{max:0,user:1}"},
        {"id":"head-shake", "category":"head", "name":"Head Shake", "xml":"<eyesnarrow/><headshake/><eyesnormal/>+{max:0,user:1}"},
        {"id":"head-right", "category":"head", "name":"Head Right", "xml":"<eyeswide/><headleft/>+{max:10}+<eyesnormal/><headuser/>+{max:0,user:1}"},
        {"id":"head-left", "category":"head", "name":"Head Left", "xml":"<eyeswide/><headright/>+{max:10}+<eyesnormal/><headuser/>+{max:0,user:1}"},
        {"id":"head-down", "category":"head", "name":"Head Down", "xml":"<eyeswide/><headdown/>+{max:10}+<eyesnormal/><headuser/>+{max:0,user:1}"},
        {"id":"head-up", "category":"head", "name":"Head Up", "xml":"<eyeswide/><headup/>+{max:10}+<eyesnormal/><headuser/>+{max:0,user:1}"},
        {"id":"head-down-right", "category":"head", "name":"Head Down Right", "xml":"<eyeswide/><headtiltleft/>+{max:10}+<eyesnormal/><headuser/>+{max:0,user:1}"},
        {"id":"head-down-left", "category":"head", "name":"Head Down Left", "xml":"<eyeswide/><headtiltright/>+{max:10}+<eyesnormal/><headuser/>+{max:0,user:1}"},

        {"id":"surprise", "category":"emotive", "name":"Surprise", "xml":"<surprise/>+{max:0,user:1}"},
        {"id":"angry", "category":"emotive", "name":"Angry", "xml":"<handsinback/><angry/><handsbyside/>+{max:0,user:1}"},
        {"id":"confused", "category":"emotive", "name":"Confused", "xml":"<handup/><confused/><handsbyside/>+{max:0,user:1}"},
        {"id":"frustrated", "category":"emotive", "name":"Frustrated", "xml":"<handsup/><lookup/>+{max:10}+<lookuser/><handsbyside/>+{max:0,user:1}"},
        {"id":"happy", "category":"emotive", "name":"Happy", "xml":"+{max:10}+<bigsmile/>+{max:0,user:1}"},
        {"id":"sad", "category":"emotive", "name":"Sad", "xml":"<handsinback/><sad/><handsbyside/>+{max:0,user:1}"},
        {"id":"wink", "category":"emotive", "name":"Wink", "xml":"+{max:10}+<wink/>+{max:0,user:1}"},

        {"id":"surprise", "category":"emotive-head", "name":"Surprise", "xml":"<surprise/>+{max:0,user:1}"},
        {"id":"angry", "category":"emotive-head", "name":"Angry", "xml":"<angry/>+{max:0,user:1}"},
        {"id":"confused", "category":"emotive-head", "name":"Confused", "xml":"<confused/>+{max:0,user:1}"},
        {"id":"frustrated", "category":"emotive-head", "name":"Frustrated", "xml":"<lookup/>+{max:10}+<lookuser/>+{max:0,user:1}"},
        {"id":"happy", "category":"emotive-head", "name":"Happy", "xml":"<bigsmile/>+{max:0,user:1}"},
        {"id":"sad", "category":"emotive-head", "name":"Sad", "xml":"<sad/>+{max:0,user:1}"},
        {"id":"wink", "category":"emotive-head", "name":"Wink", "xml":"<wink/>+{max:0,user:1}"},

        {"id":"angry", "category":"emotive-cs", "name":"Angry", "xml":"<angry/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"confused", "category":"emotive-cs", "name":"Confused", "xml":"<confused/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"frustrated", "category":"emotive-cs", "name":"Frustrated", "xml":"<frustrated/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"happy", "category":"emotive-cs", "name":"Happy", "xml":"<happy/>+{max:10}+<handsbyside/>+{max:0,user:1}"},

        {"id":"hi", "category":"conversational", "name":"Hi", "xml":"<headup/><palmup/><palmwave/><lookuser/><handsbyside/>+{max:0,user:1}"},
        {"id":"aha", "category":"conversational", "name":"Aha", "xml":"<fingerup/><headup/><eyeswide/>+{max:15}+<lookuser/><eyesnormal/><handsbyside/>+{max:0,user:1}"},
        {"id":"stop", "category":"conversational", "name":"Stop", "xml":"<headtiltright/><eyeswide/><palmup/>+{max:15}+<eyesnormal/><lookuser/><handsbyside/>+{max:0,user:1}"},
        {"id":"emphasize", "category":"conversational", "name":"Emphasize", "xml":"<headright/><eyeswide/><handup/>+{max:10}+<handemph/><handemph/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"to-me", "category":"conversational", "name":"To Me", "xml":"<eyeswide/><headright/><handsin/>+{max:15}+<eyesnormal/><lookuser/><handsbyside/>+{max:0,user:1}"},
        {"id":"to-you", "category":"conversational", "name":"To You", "xml":"<eyeswide/><headtiltright/><handsup/>+{max:15}+<eyesnormal/><lookuser/><handsbyside/>+{max:0,user:1}"},
        {"id":"quote", "category":"conversational", "name":"Quote", "xml":"<fingersup/><headup/><eyeswide/><fingersquote/><fingersquote/>+{max:15}+<lookuser/><eyesnormal/><handsbyside/>+{max:0,user:1}"},
        {"id":"weigh", "category":"conversational", "name":"Weigh", "xml":"<headtiltright/><eyeswide/><handsup/><handsweigh/>+{max:10}+<handsbyside/>+{max:0,user:1}"},
        {"id":"hands-in-back", "category":"conversational", "name":"Hands In Back", "xml":"<eyeswide/><handsinback/><headup/>+{max:10}+<lookuser/><eyesnormal/>+{max:0,user:1}"},

        {"id":"hi", "category":"conversational-cs", "name":"Hi", "xml":"<hi/>+{max:15}+<handsbyside/>+{max:0,user:1}"},
        {"id":"aha", "category":"conversational-cs", "name":"Aha", "xml":"<aha/>+{max:15}+<handsbyside/>+{max:0,user:1}"},
        {"id":"thumbs-up", "category":"conversational-cs", "name":"Thumbs Up", "xml":"<thumbsup/>+{max:15}+<handsbyside/>+{max:0,user:1}"},
        {"id":"thinking", "category":"conversational-cs", "name":"Thinking", "xml":"<thinking/>+{max:15}+<handsbyside/>+{max:0,user:1}"},

        {"id":"next", "category":"navigate", "name":"Next"},
        {"id":"previous", "category":"navigate", "name":"Previous"},
        {"id":"first-and-stop", "category":"navigate", "name":"First"},

        {"id":"link", "category":"misc", "name":"Link"},
        {"id":"code", "category":"misc", "name":"JavaScript"},

        {"id":"blink", "category":"idle", "name":"Blink", "xml":"<blink/>"},
        {"id":"headidle1", "category":"idle", "name":"Head Idle 1", "xml":"<headrandom1/><pause cms=\"300\"/><headuser/>"},
        {"id":"headidle2", "category":"idle", "name":"Head Idle 2", "xml":"<headrandom4/><pause cms=\"300\"/><headuser/>"},
        {"id":"headidle3", "category":"idle", "name":"Head Idle 3", "xml":"<headrandom1/><pause cms=\"300\"/><headrandom4/><pause cms=\"300\"/><headuser/>"},
        {"id":"bodyidle1", "category":"idle", "name":"Body Idle 1", "xml":"<headrandom1/><swayarms/><headuser/>"}
    ];

    var actionCategories = [
        {"id":"look", "name":"Look", "characterStyles":["realistic-body","realistic-bust","realistic-head","illustrated-head","illustrated-body","cgi-body","cgi-bust","cgi-head","classic"]},
        {"id":"look-limited", "name":"Look", "characterStyles":["cs"]},
        {"id":"gesture", "name":"Gesture", "characterStyles":["realistic-body","cgi-body","illustrated-body","classic"]},
        {"id":"point", "name":"Point", "characterStyles":["realistic-body","cgi-body","classic"]},
        {"id":"point-cs", "name":"Point", "characterStyles":["cs"]},
        {"id":"eyes", "name":"Eyes"},
        {"id":"head", "name":"Head"},
        {"id":"emotive", "name":"Emotive", "characterStyles":["realistic-body","realistic-bust","illustrated-body","cgi-body","cgi-bust","classic"]},
        {"id":"emotive-head", "name":"Emotive", "characterStyles":["realistic-head","illustrated-head","cgi-head"]},
        {"id":"emotive-cs", "name":"Emotive", "characterStyles":["cs"]},
        {"id":"conversational", "name":"Conversational", "characterStyles":["realistic-body","realistic-bust","illustrated-body","cgi-body","cgi-bust","classic"]},
        {"id":"conversational-cs", "name":"Conversational", "characterStyles":["cs"]}
    ];

    function actionCategoryObject(id) {
        for (var i = 0; i < actionCategories.length ; i++)
            if (actionCategories[i].id == id)
                return actionCategories[i];
        return null;
    }

    function getActionTemplateFromTag(tag, character) {
        var style = characterObject(character).style;
        for (var i = 0; i < actions.length; i++) {
            if (actions[i].id == tag) {
                var category = actionCategoryObject(actions[i].category);
                if (!category || !category.characterStyles || category.characterStyles.indexOf(style) != -1)  // Because characters that don't support a certain action should ignore that action
                    return actions[i].xml;
            }
        }
        return "";
    }

    function textureHelper(tag, o) {
        // general rule is e.g. look-down-left -> LookDownRight (right and left swapped because character uses stage left / stage right)
        var cap = true;
        var s = "";
        for (var i = 0; i < tag.length; i++) {
            if (tag[i] == "-")
                cap = true;
            else {
                s += cap ? tag[i].toUpperCase() : tag[i];
                cap = false;
            }
        }
        s = s.replace("Left", "XXX");
        s = s.replace("Right", "Left");
        s = s.replace("XXX", "Right");
        o[s] = null;
    }

    // Seeded random

    var seed = 1;

    function setRandomSeed(say) {
        say = say||"";
        // Seed our random with the say text
        seed = 1;
        for (var i = 0; i < say.length; i++)
            seed += 13 * say.charCodeAt(i);
    }

    function seededRandom() {
        var x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }

    function getActionFromActionTemplate(action, say, audiotag, bob) {
        if (say || audiotag) {
            say = say||"";
            //console.log("seed="+seed+" bob="+bob);
            // action: "<lookleft/><gestureleft/><cmd type='apogee'>+{max:5}+<lookuser/><handsbyside/>+{max:0,user:1}"
            var a = action ? action.split("+") : ["{max:0,user:1}"];  // latter is the default Look At User (user=1 means character is looking at the user)
            // e.g. a = ["{max:0,user:1}"]
            //      a = ["<lookleft/><gestureleft/><cmd type='apogee'>", "{max:5}", "<lookuser/><handsbyside/>", "{max:0,user:1}"]
            var b = splitSay(say); // e.g. ["this", "is", "a", "test"]
            var j = 0; // index into b
            var wordsSinceBlink = 0;
            var s = "";
            for (var i = 0; i < a.length; i++) {
                if (a[i].substr(0,1) != '{') {
                    s += a[i]; // regular action commands
                }
                else {
                    var rec = JSON.parse(a[i].replace('max','"max"').replace('user','"user"'));
                    var c = rec.max;
                    // Case where there were no (or few) words - i.e. user used an audio file but neglected to give us a script, or an unusually short script - insert a pause
                    if (c > 0 && b.length <= 3)
                        s += "<pause/>";
                    // peel off up to max words (or all the words)
                    while (j < b.length && (c > 0 || rec.max == 0)) { // while there are words left and we have not exceeded our max, if any
                        s += b[j];  // add next word
                        if (j < b.length - 1) { // if this is not the last word, add a space OR a command
                            if (!rec.user)
                                s += " "; // there can be no head-bob here, e.g. head turned - and might as well not blink either
                            else {
                                if (bob && j < b.length - 5 && seededRandom() < 0.33) { // roughly 1/3 words get a bob, but not right towards the end
                                    s += randomHead();
                                }
                                else if (wordsSinceBlink > 10) {
                                    s += " <blink/> ";
                                    wordsSinceBlink = 0;
                                }
                                else s += " ";
                            }
                        }
                        wordsSinceBlink++;
                        j++;
                        c--;
                    }
                }
            }
            action = "<say>" + s + "</say>";
        }
        else {
            // Case where user has no script or audio tag - just an action - now we need to interpret our tags a bit differently
            var a = action ? action.split("+") : [];
            var s = "";
            for (var i = 0; i < a.length; i++) {
                if (a[i].substr(0,1) != '{') {
                    s += a[i]; // regular action commands
                }
                else {
                    var rec = JSON.parse(a[i].replace('max','"max"').replace('user','"user"'));
                    if (rec.max) s += "<pause/>"; // this is what we had before our switch to +{}+ commands
                }
            }
            action = s;
        }
        return action;
    }

    function splitSay(say) {
        // like say.split(" ") but [] count as one word
        var a = [];
        var p1 = say.indexOf("[");
        while (p1 != -1) {
            var p2 = say.indexOf("]", p1);
            a = a.concat(say.substr(0, p1).split(" "));
            a.push(say.substr(p1, p2-p1+1));
            say = say.substr(p2+1);
            p1 = say.indexOf("[");
        }
        a = a.concat(say.split(" "));
        return a;
    }

    function randomHead() {
        var n = (1+Math.floor(seededRandom()*4));
        if (n == 3) return " <headuser/> "
        else return " <headrandom"+n+"/> ";
    }

    start();
}
