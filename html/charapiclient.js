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
    var saveState = false;
    var clientScale = 1;
    var idleData = null;
    var fpsInterval, now, then, elapsed; // used in animate

    function resetOuterVars() {
        fade = true;
        playQueue = [];
        playCur = null;
        playShield = false;
        idleType = "normal";
        saveState = false;
        clientScale = 1;
        idleData = null;
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

        // These are parameters known to the client
        if (typeof params.preload === "boolean") preload = params.preload;
        if (typeof params.fade === "boolean") fade = params.fade;
        if (typeof params.playShield === "boolean") playShield = params.playShield; // effectively forces autoplay
        if (typeof params.idleType === "string") idleType = params.idleType; // "none"/"blink"/"normal"
        if (typeof params.saveState === "boolean") saveState = params.saveState; // initial state of 2nd dynamicPlay is the final state of the previous one
        if (typeof params.idleData === "object") idleData = params.idleData; // get this from the catalog - tells us how to idle this character
        if (typeof params.clientScale === "number") clientScale = params.clientScale; // use this to tell the client to further scale the server image by the given factor. Use with raster characters.
        if (typeof params.model === "object") model = params.model; // can provide your own 3d model
        if (typeof params.displayDensity === "number") displayDensity = params.displayDensity; // for 3d only

        setupScene();
        if (playShield) setupPlayShield(params.width, params.height);
        setupCharacter();
    }

    function setupScene() {
        var div = document.getElementById(divid);
        var cx = params.width;
        var cy = params.height;
        var cx2 = cx * clientScale;
        var cy2 = cy * clientScale;
        var scale = 1;
        if (displayDensity) {
            cx *= displayDensity;
            cy *= displayDensity;
            cx2 *= displayDensity;
            cy2 *= displayDensity;
            scale = 1/displayDensity;
        }
        var s = '';
        s += '<div id="' + divid + '-top' + '" style="visibility:hidden; width:' + cx + 'px; height:' + cy + 'px; position:relative; overflow: hidden; transform:scale(' + scale + '); transform-origin: top left;">';
        s += '  <canvas id="' + divid + '-canvas" width="' + cx + '" height="' + cy + '" style="position:absolute; top:0px; left:0px; width:' + cx2 + 'px; height:' + cy2 + 'px;"></canvas>';
        if (playShield)
            s += '  <canvas id="' + divid + '-playshield-canvas" style="position:absolute; left:0px; top:0px;" width="' + cx +'px" height="' + cy + 'px"/></canvas>';
        if (!audioContext)
            s += '  <audio id="' + divid + "-audio" + '"></audio>';
        s += '</div>'
        div.innerHTML = s;
    }

    function setupCharacter() {
        execute("", "", null, null, false, null); // first load results in characterLoaded
    }

    function characterLoaded() {
        var topDiv = document.getElementById(divid + "-top");
        if (topDiv) topDiv.style.visibility = "visible";

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

    this.state = function() {
        return initialState;
    };

    this.dynamicPlay = function(o) {
        if (audioContext) audioContext.resume();
        if (o) {
            // Process the object
            if (typeof o.say == "number") o.say = o.say.toString();
            else if (typeof o.say != "string") o.say = "";
            if (!loading && !animating) {
                playCur = o;
                execute(o.do, o.say, o.audio, o.lipsync, false, onPlayDone);
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

    this.setIdleType = function(t) {
        idleType = t;
    };


    function onPlayDone() {
        if (playQueue.length > 0) {
            playCur = playQueue.shift();
            execute(playCur.do, playCur.say, playCur.audio, playCur.lipsync, false, onPlayDone);
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

    function showTranscript() {
        if (stagedTranscript) {
            document.getElementById(divid).dispatchEvent(createEvent("closedCaption", transcriptFromText(stagedTranscript)));
            stagedTranscript = undefined;
        }
    }

    function makeGetURL(addedParams) { // addedParams starts with & if truthy
        // Caller-supplied endpoint
        var url = params.endpoint;
        // Additional parameters from the caller, e.g. character
        for (var key in params) {
            if (key && key != "endpoint" && key != "fade" && key != "idleType" && key != "autoplay" && key != "playShield" && key != "preload" && key != "saveState" && key != "idleData" && key != "clientScale" && key != "model" && key != "displayDensity") // minus the parameters for charapiclient
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
    var frame;                      // Current frame of animation
    var stopping;                   // True if we are stopping an animation - overlaps animating
    var starting;                   // True if we are starting an animation - overlaps animating
    var executeCallback;            // What to call on execute() return, i.e. when entire animation is complete
    var rafid;                      // Defined only when at least one character is animating - otherwise we stop the RAF (game) loop
    var atLeastOneLoadError;        // We use this to stop idle after first load error

    // Idle
    var idleTimeout;
    var timeSinceLastIdleCheck;
    var timeSinceLastAction;            // Time since any action, reset on end of a message - drives idle priority
    var timeSinceLastBlink;             // Similar but only for blink
    var lastIdle = "";                  // Avoid repeating an idle, etc.
    var idleCache = {};                 // Even though idle resources are typically in browser cache, we prefer to keep them in memory, as they are needed repeatedly    

    // Settle feature
    var timeSinceLastAudioStopped = 0;   // Used to detect if and how much we should settle for
    var settleTimeout;              // If non-0, we are animating true but are delaying slightly at the beginning to prevent back-to-back audio
    var delayTimeout;               // If non-0, we are animating true but are delaying audio slightly for leadingSilence

    // Preloading
    var preload = true;         // Master switch (a param normally)
    var preloaded = [];         // list of things we already pulled on
    var preloadQueue = [];      // de-duped list of urls to pull on
    var preloading = null;     // url being preloaded
    var preloadTimeout = null;  // defined if a preload timeout is outstanding

    // HD characters
    var canvasTransformSrc = [];
    var canvasTransformDst = [];
    var sway = 0;               // if swaying, actual sway angle
    var swayTime;               // time of last sway frame
    var swayTarget;             // target angle in radians
    var swayAccel;              // proportion of distance from sway to swayTarget    
    var breath = 0;             // if breathing, actual (max) shoulder displacement
    var breathTime = 0;         // used to compute breath
    var random = undefined;     // random walk controllers
    var suppressRandom = false;
    
    // 3D characters
    var scene;
    var renderer;
    var camera;
    var model;
    var displayDensity;
    
    // Misc
    var stagedTranscript;
    
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
        frame = undefined;
        stopping = undefined;
        starting = undefined
        executeCallback = undefined;
        idleTimeout = null;
        rafid = null;

        idleTimeout = null;
        timeSinceLastIdleCheck = 0;
        timeSinceLastAction = undefined;
        timeSinceLastBlink = undefined;
        lastIdle = "";

        timeSinceLastAudioStopped = 0;
        settleTimeout = undefined;
        delayTimeout = undefined;

        preload = true;
        preloaded = [];
        preloadQueue = [];
        preloading = null;
        preloadTimeout = null;
        
        random = undefined;
        suppressRandom = false;
        
        scene = null;
        renderer = null;
        camera = null;
        model = null;
    }

    function execute(tag, say, audio, lipsync, idle, callback) {
        if (loading || animating) {
            console.log("internal error"); // execute called on a character while animating that character
            return;
        }

        if (random && random.length > 0 && !idle) suppressRandom = true; // immediately drive any random controllers to 0 (idles are assumed not to start with an immediate hand action)

        if (say) stageTranscript(transcriptFromText(say));

        executeCallback = callback;

        stopping = false;
        loading = true;
        animating = false;

        var addedParams = "";

        secondaryTextures = {};
        if (saveState) addedParams += "&initialstate=" + initialState;
        addedParams = addedParams + '&do=' + (tag||"");
        addedParams = addedParams + '&say=' + encodeURIComponent(say||"");

        if (say && containsActualSpeech(say)) {
            if (audio && lipsync)
                speakRecorded(addedParams, audio, lipsync);
            else 
                speakTTS(addedParams);
        }
        else {
            loadAnimation(addedParams, false, idle);
        }
    }

    function containsActualSpeech(say) {
        if (!say) return false;
        var textOnly = say.replace(/\[[^\]]*\]/g, ""); // e.g. "Look [cmd] here." --> "Look here."
        if (!textOnly) return false;
        var hasNonWhitespace = !!textOnly.match(/\S/);
        return hasNonWhitespace;
    }
    
    function stageTranscript(text) {
        stagedTranscript = text;
    }

    function transcriptFromText(s) {
        // Filter out tags - adjust for extra space, remove [spoken]...[/spoken] leave [written]...[/written] contents.
        if (typeof(s) == "string") {
            s = s.replace(/\[written\](.*?)\[\/written\]/g, "$1");
            s = s.replace(/\[spoken\].*?\[\/spoken\]/g, "");
            s = s.replace(/\[[^\[]*\]/g, function(x) {return ""});
            s = s.trim().replace(/  /g, " ");
        }
        return s;
    }

    function speakRecorded(addedParams, audioURL, lipsync) {
        addedParams = addedParams + '&lipsync=' +  encodeURIComponent(lipsync);
        // load the audio, but hold it
        if (audioContext) { // Normal case
            var xhr = new XMLHttpRequest();
            xhr.open('GET', audioURL, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = function () {
                audioContext.decodeAudioData(xhr.response, function (buffer) {
                    audioBuffer = buffer;
                    loadAnimation(addedParams, true, false);
                }, function (e) {
                    animateFailed();
                });
            };
            xhr.onerror = function() {animateFailed();}
            xhr.send();
        }
        else { // IE only
            var audio = document.getElementById(divid + "-audio");
            audio.oncanplaythrough = function() {
                audio.pause();
                loadAnimation(addedParams, true, false);
            };
            audio.onerror = function() {animateFailed();}
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
                    loadAnimation(addedParams, true, false);
                }, function (e) {
                    animateFailed();
                });
            };
            xhr.onerror = function() {animateFailed();}
            xhr.send();
        }
        else { // IE only
            var audio = document.getElementById(divid + "-audio");
            audio.oncanplaythrough = function() {
                audio.pause();
                if (preloaded.indexOf(audioURL) == -1) preloaded.push(audioURL);
                loadAnimation(addedParams, true, false);
            };
            audio.onerror = function() {animateFailed();}
            audio.src = audioURL;
        }
    }

    function loadAnimation(addedParams, startAudio, idle) {
        var dataURL = makeGetURL(addedParams + "&type=data");
        var imageURL = makeGetURL(addedParams + "&type=image");
        
        // Idle cache shortcut
        if (idleCache[dataURL] && idleCache[imageURL]) {
            animData = idleCache[dataURL];
            texture = idleCache[imageURL];
            recordSecondaryTextures();
            loadSecondaryTextures(addedParams, startAudio);
            return;
        }
        
        // Load the data
        var xhr = new XMLHttpRequest();
        xhr.open('GET', dataURL, true);
        xhr.onload = function () {
            
            try {
                animData = JSON.parse(xhr.response);
            } catch(e) {animateFailed();}

            // 3d model case
            if (animData.targets) {
                if (!model) {
                    if (typeof THREE != "object") return console.error("Missing three.js");
                    if (typeof THREE.GLTFLoader != "function") return console.error("Missing GLTFLoader.js");
                    var glbURL = makeGetURL(addedParams + "&type=model").replace("format=png","format=glb").replace("format=jpeg","format=glb");
                    var loader = new THREE.GLTFLoader();
                    loader.load(glbURL, function(gltf) {model = gltf.scene; setup3d(); getItStarted(startAudio);}, undefined, function(error) {console.error(error);});
                    return;
                }
                else { // case where caller provides it's own model via 'model' parameter
                    setup3d();
                    return getItStarted(startAudio);
                }
            }
            
            // Load the image
            texture = new Image();
            texture.crossOrigin = "Anonymous";
            texture.onload = function() {
                
                // Populate idle cache
                if (idle) {
                    idleCache[dataURL] = animData;
                    idleCache[imageURL] = texture;
                }
                
                recordSecondaryTextures();
                loadSecondaryTextures(addedParams, startAudio);
            };
            texture.onerror = function() {animateFailed();}
            texture.src = imageURL;
        }
        xhr.onerror = function() {animateFailed();}
        xhr.send();
        
        // No need to preload these
        if (imageURL && preloaded.indexOf(imageURL) == -1) preloaded.push(imageURL);
        if (dataURL && preloaded.indexOf(dataURL) == -1) preloaded.push(dataURL);
    }

    function recordSecondaryTextures() {
        secondaryTextures = {};
        for (var i = 0; i < animData.textures.length; i++) {
            if (animData.textures[i] != "default")
                secondaryTextures[animData.textures[i]] = null;
        }
    }
    
    function loadSecondaryTextures(addedParams, startAudio) {
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
            
            // idle cache shortcut
            if (idleCache[textureURL]) {
                secondaryTextures[key] = idleCache[textureURL];
                loadSecondaryTextures(addedParams, startAudio);
                return;
            }
            
            secondaryTextures[key] = new Image();
            secondaryTextures[key].crossOrigin = "Anonymous";
            secondaryTextures[key].onload = function () {
                
                // populate idle cache
                if (addedParams.indexOf("&idle=") != -1)
                    idleCache[textureURL] = secondaryTextures[key];
                // load some more
                loadSecondaryTextures(addedParams, startAudio);
            };
            secondaryTextures[key].onerror = function() {animateFailed();}
            secondaryTextures[key].src = textureURL;
            if (textureURL && preloaded.indexOf(textureURL) == -1) preloaded.push(textureURL);
        }
    }

    // just fire and forget at any time, as if you were running execute
    function preloadExecute(tag, say, audio, lipsync) {
        var addedParams = "";
        if (saveState) addedParams += "&initialstate=" + initialState;
        addedParams = addedParams + '&do=' + encodeURIComponent(tag||"");
        addedParams = addedParams + '&say=' + encodeURIComponent(say||"");
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
        xhr.onload = function() {
            if (preloading) {
                if (preloaded.indexOf(preloading) == -1)
                    preloaded.push(preloading);
                // if this was animation data, then also find secondary textures
                if (preloading.indexOf("&type=data") != -1) {
                    var animDataPreload = JSON.parse(xhr.response);
                    for (var i = 0; i < (animDataPreload.textures||[]).length; i++) {
                        if (animDataPreload.textures[i] != "default")
                            preloadHelper(makeGetURL("&texture=" + animDataPreload.textures[i] + "&type=image"));
                    }
                }
                preloading = null;
            }
            // restart in a bit
            if (preloadQueue.length > 0)
                preloadTimeout = setTimeout(preloadSomeMore, 500);
        };
        xhr.send();
    }

    function getItStarted(startAudio) {
        // render the first frame and start animation loop
        loading = false;
        showTranscript();
		// case where we are stopping before we got started
		if (stopping) {
		    animateComplete();
    		return;
		}
        animating = true;
        starting = true;

        // Settling feature - establish a minimum time between successive animations - mostly to prevent back to back audio - because we are so good at preloading
        if (settleTimeout) {clearTimeout(settleTimeout); settleTimeout = 0;}
        var t = Date.now();
        if (t - timeSinceLastAudioStopped < 333) {
            settleTimeout = setTimeout(onSettleComplete.bind(null, startAudio), 333 - (t - timeSinceLastAudioStopped));
        }
        else {
            getItStartedCheckDelay(startAudio);
        }
    }

    function onSettleComplete(startAudio) {
        settleTimeout = 0;
        getItStartedCheckDelay(startAudio);
    }

    function getItStartedCheckDelay(startAudio) {
        if (delayTimeout) {clearTimeout(delayTimeout); delayTimeout = 0;}
        if (animData.leadingSilence && startAudio) {
            delayTimeout = setTimeout(onDelayComplete, animData.leadingSilence);
            getItStartedActual(false);
        }
        else {
            getItStartedActual(startAudio);
        }
    }

    function onDelayComplete() {
        delayTimeout = 0;
        getItStartedActual(true);
    }

    function getItStartedActual(startAudio) {
        // start animation loop if needed
        if (!rafid) {
            rafid = requestAnimationFrame(animate);
            fpsInterval = 1000 / animData.fps;
            then = Date.now();
        }
        // start audio
        if (startAudio) {
            if (audioContext) {
                try {
                    if (audioSource) audioSource.stop();
                    audioSource = audioContext.createBufferSource();
                    audioSource.buffer = audioBuffer;
                    audioSource.connect(gainNode);
                    gainNode.gain.value = 1;
                    audioSource.start();
                } catch(e){}                    
            }
            else {
                var audio = document.getElementById(divid + "-audio");   // for use with playAudio
                audio.play();
            }
            // you can use this event to start playing audio, if you are managing audio externally
            document.getElementById(divid).dispatchEvent(createEvent("playStarted"));
        }
        starting = false;
		// animation impacts sway in a subtle way
		if (Math.random() < 0.5) swayTarget = sway;
        // simple strategy - when there is stuff to preload, slip one in every second or so - rarely does it lock up load channels for actual loads
        if (!preloadTimeout && preload)
            preloadTimeout = setTimeout(preloadSomeMore, 500);
    }

    function animate() {
		rafid = null;
		now = Date.now();
        elapsed = now - then;
        if (elapsed <= fpsInterval) {
            rafid = requestAnimationFrame(animate);
            return;
        }
        then = now - (elapsed % fpsInterval);
        var framesSkip = Math.max(1, Math.floor(elapsed / fpsInterval)) - 1;
        //if (framesSkip > 0) console.log("dropped "+framesSkip+" frame(s)");
        
        var completed = undefined;
        var update = false;
        if (animData) {
            if (!random) initRandomWalk(animData);
            var swaying = !!animData.swayLength;
            if (swaying) {  // For HD character an update can occur because of sway, or actual animation, and often both.
                updateSway(1+framesSkip);
                if (animData.breathCycle) updateBreath();
                update = true;
            }
            if (animating && !starting) {
                // exit case
                if (frame == -1) {
                    completed = true;
                }
                else {
                    if (frame === undefined) 
                        frame = 0;
                    else { 
                        var frameNew = frame + 1 + framesSkip;
                        while (frame < frameNew) {
                            if (animData.frames[frame][1] == -1) break; // regardless, never move past -1 (end of animation) frame
                            if (stopping && animData.frames[frame][1]) break; // and when recovering, another recovery frame can occur
                            frame++;
                        }
                    }
                    update = true;
                }
            }
            
            if (update) {

                var canvas = document.getElementById(divid + "-canvas");
                var framerec = animData.frames[frame];
                // 2D
                if (canvas && !renderer) {
                    if (animating && !starting && framerec) { // HD characters only update the offscreen canvas when actually animating
                        if (random.length > 0) controlRandomWalkSuppression(animData, frame);
                        var ctx;
                        if (!swaying) {
                            ctx = canvas.getContext("2d");
                        }
                        else {  // if we are an HD character, we'll blit to an offscreen canvas instead
                            if (!canvasTransformSrc["G"]) {
                                canvasTransformSrc["G"] = document.createElement('canvas');
                                canvasTransformSrc["G"].width = canvas.width;
                                canvasTransformSrc["G"].height = canvas.height + (animData.clothingOverhang||0);
                            }
                            ctx = canvasTransformSrc["G"].getContext('2d', {willReadFrequently:true});
                        }
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        if (animData.recipes) {
                            var recipe = animData.recipes[framerec[0]];
                            for (var i = 0; i < recipe.length; i++) {
                                var iTexture = recipe[i][6];
                                var textureString = (typeof iTexture == "number" ? animData.textures[iTexture] : "");
                                
                                var src;
                                if (textureString == 'default' && defaultTexture)
                                    src = defaultTexture;
                                else if (secondaryTextures && secondaryTextures[textureString])
                                    src = secondaryTextures[textureString];
                                else
                                    src = texture;
                                
                                var process = recipe[i][7]||0;
                                if (process >= 11 && process < 20) updateRandomWalk(process);
                                if (process == 1 || process == 2) {
                                    var o = updateTransform(src, recipe, i);
                                    var process = recipe[i][7];
                                    ctx.drawImage(canvasTransformDst[process-1],
                                        0, 0,
                                        recipe[i][4], recipe[i][5],
                                        recipe[i][0] + o.x, recipe[i][1] + o.y,
                                        recipe[i][4], recipe[i][5]);
                                }
                                else if (params.format == "png") {
                                    // png characters replacement overlays with alpha need to first clear bits they replace e.g. hands up
                                    if (!animData.layered && process != 3) {
                                        ctx.clearRect(
                                            recipe[i][0], recipe[i][1],
                                            recipe[i][4], recipe[i][5]
                                        );
                                    }
                                    ctx.drawImage(src,
                                        recipe[i][2], recipe[i][3] + (process >= 11 && process < 20 ? recipe[i][5] * random[process - 10].frame : 0),
                                        recipe[i][4], recipe[i][5],
                                        recipe[i][0], recipe[i][1] + (process == 3 ? animData.clothingOverhang||0 : 0), // in HD process 3 (clothing), clothing can be artificially high by clothingOverhang pixels, and needs to be shifted down again here,
                                        recipe[i][4], recipe[i][5]);
                                }
                                else {
                                    ctx.drawImage(src,
                                        recipe[i][2], recipe[i][3],
                                        recipe[i][4], recipe[i][5],
                                        recipe[i][0], recipe[i][1],
                                        recipe[i][4], recipe[i][5]);
                                }
                            }
                        }
                        else { // simpler, strip format
                            ctx.drawImage(texture, 0, 0, params.width, params.height, 0, 0, params.width, params.height);
                        }
                    }    
                    if (swaying) { // for HD characters, this is where the actual canvas gets updated - often the offscreen canvas will remain unchanged
                        updateGlobalTransform(sway, canvas);
                    }
                }
                
                // 3D
                if (canvas && renderer) {
                    if (animData.recipes) {
                        var recipe = animData.recipes[framerec[0]];
                        var mesh = null;
                        model.traverse(o => {
                            if (o.type == "SkinnedMesh")
                                mesh = o;
                        });
                        if (mesh) mesh.updateMorphTargets();
                        for (var i = 0; i < recipe.length; i++) {
                            var name = animData.targets[recipe[i][0]];
                            if (recipe[i].length == 2) { // morph target
                                if (mesh) {
                                    for (var j = 0; j < mesh.userData.targetNames.length; j++) {
                                        if (mesh.userData.targetNames[j] == name) {
                                            mesh.morphTargetInfluences[j] = recipe[i][1];
                                            break;
                                        }
                                    }
                                }
                            }
                            else { // bone target
                                var bone = null;
                                model.traverse(o => {
                                    if (o.isBone && o.name === name)
                                        bone = o;
                                });
                                if (bone) {
                                    bone.rotation.x = THREE.Math.degToRad(recipe[i][1]);
                                    bone.rotation.y = THREE.Math.degToRad(recipe[i][2]);
                                    bone.rotation.z = THREE.Math.degToRad(recipe[i][3]);
                                    if (recipe[i][4] !== undefined) {
                                        bone.position.x = recipe[i][4];
                                        bone.position.y = recipe[i][5];
                                        bone.position.z = recipe[i][6];
                                    }
                                    if (recipe[i][7] !== undefined) {
                                        bone.scale.x = recipe[i][7];
                                        bone.scale.y = recipe[i][8];
                                        bone.scale.z = recipe[i][9];
                                    }
                                }
                            }
                        }
                    }
                    renderer.render(scene, camera);
                }

                if (framerec) {
                    // third arg is an extensible side-effect string that is triggered when a given frame is reached
                    if (framerec[2])
                        onEmbeddedCommand(framerec[2]);
                    // second arg is -1 if this is the last frame to show, or a recovery frame to go to if stopping early
                    var recoveryFrame = animData.frames[frame][1];
                    if (recoveryFrame == -1) {
                        frame = -1;
                    }
                    else if (stopping && recoveryFrame) {
                        frame = recoveryFrame;
                    }
                }
            }
        }

        if (completed) {
            animating = false;
            stopping = false;
            frame = undefined;
            animateComplete();
        }
        
        rafid = requestAnimationFrame(animate);
    }

    function stopAll() {
        if (audioContext) {
            if (gainNode) gainNode.gain.setTargetAtTime(0, audioContext.currentTime, 0.015);
            timeSinceLastAudioStopped = Date.now();
        }
        else {
            var audio = document.getElementById(divid + "-audio");
            if (audio) audio.pause();
        }
        if (loading || animating)
            stopping = true;
        if (delayTimeout) {
            clearTimeout(delayTimeout);
            delayTimeout = 0;
        }
        if (settleTimeout) {
            clearTimeout(settleTimeout);
            settleTimeout = 0;
            animating = false;
            animateComplete();
        }
    }

    function animateFailed() {
        console.log("Service error");
        atLeastOneLoadError = true;
        loading = false;
        animateComplete();
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

    // Needed for HD characters only
    
    function initRandomWalk(animData) {
        random = [];
        for (var n = 1; n <= 9; n++) {
            var s = animData["random"+n];
            if (s) random[n] = {frame:0, inc:0, count:0, frames:parseInt(s.split(",")[0])};
        }
    }

    function controlRandomWalkSuppression(animData, frame) {
        // Are layers with random process present in the next 6 frames? If so, suppressRandom = true, else false.
        var present = true;
        try {
            for (var d = 0; d < 6; d++) {
                var frameTest = frame + d;
                if (animData.frames[frameTest][1] == -1 || stopping && animData.frames[frameTest][1]) break; // stop searching when we run out of frames
                var framerec = animData.frames[frameTest];
                var recipe = animData.recipes[framerec[0]];
                var found = false;
                for (var i = 0; i < recipe.length; i++) {
                    var process = recipe[i][7]||0;
                    if (process >= 11 && process < 20) {found = true; break;}
                }
                if (!found) {present = false; break;}
            }
        } catch(e) {}
        suppressRandom = !present;
    }

    function updateRandomWalk(process) {
        var n = process - 10;
        // drive rapidly to frame 1
        if (suppressRandom) {
            if (random[n].frame > 1) random[n].frame = Math.round(random[n].frame/2);
            random[n].count = 0;
            random[n].inc = 0;
            return;
        }
        // execute a count of steps in a given direction
        if (random[n].count > 0) {
            random[n].frame = Math.max(0, Math.min(random[n].frames-1, random[n].frame + random[n].inc));
            random[n].count--;
        }
        // choose new random direction and count
        else {
            random[n].count = Math.floor(random[n].frames/3) + Math.floor(Math.random() * random[n].frames);
            random[n].inc = Math.random() < 0.5 ? -1 : 1;
        }
    }
    
    function updateTransform(src, recipe, i) {
        // Gather params
        var width = recipe[i][4];
        var height = recipe[i][5];
        var xSrcImage = recipe[i][0];
        var ySrcImage = recipe[i][1];
        var process = recipe[i][7];
        var rb = process == 1 ? animData.mouthBendRadius : (process == 2 || animData.jawBendRadius != undefined ? animData.jawBendRadius : 0);
        var rt = process == 1 ? animData.mouthTwistRadius : (process == 2 || animData.jawTwistRadius != undefined ? animData.jawTwistRadius : 0);
        var bend = - recipe[i][8] / 180 * Math.PI;
        var twist = recipe[i][9] / 180 * Math.PI;
        var side = recipe[i][10] / 180 * Math.PI;
        side += twist * animData.twistToSide;
        bend += side * (animData.sideToBend||0);
        var sideLength = animData.sideLength;//*2;
        var lowerJawDisplacement = animData.lowerJawDisplacement;
        var lowerJaw = recipe[i][8];
        var shoulders = recipe[i][8];
        var x = recipe[i][11];
        var y = recipe[i][12];
        // Bend/twist are a non-linear z-rotate - side and x,y are linear - prepare a matrix for the linear portion.
        // 0 2 4 
        // 1 3 5
        var m = [1, 0, 0, 1, 0, 0];
        if (side) {
            addXForm(1, 0, 0, 1, 0, -sideLength, m);
            addXForm(Math.cos(side), Math.sin(side), -Math.sin(side), Math.cos(side), 0, 0, m);
            addXForm(1, 0, 0, 1, 0, sideLength, m);
        }
        if (x || y) {
            addXForm(1, 0, 0, 1, x, y, m);
        }
        // Extract the portion of the image we want to a new temp context and get its bits as the source
        if (!canvasTransformSrc[process-1]) {
            canvasTransformSrc[process-1] = document.createElement('canvas');
            canvasTransformSrc[process-1].width = width;
            canvasTransformSrc[process-1].height = height;
        }
        canvasTransformSrc[process-1].getContext('2d', {willReadFrequently:true}).clearRect(0, 0, width, height);
        canvasTransformSrc[process-1].getContext('2d', {willReadFrequently:true}).drawImage(src, recipe[i][2], recipe[i][3], width, height, 0, 0, width, height);
        var source = canvasTransformSrc[process-1].getContext('2d', {willReadFrequently:true}).getImageData(0, 0, width, height);
        // Get the bits for a same-size region
        if (!canvasTransformDst[process-1]) {
            canvasTransformDst[process-1] = document.createElement('canvas');
            canvasTransformDst[process-1].width = width;
            canvasTransformDst[process-1].height = height;
        }
        var target = canvasTransformSrc[process-1].getContext('2d', {willReadFrequently:true}).createImageData(width, height);
        // Return the image displacement
        var deltax = 0;
        var deltay = 0;
        if (process == 1 || animData.jawBendRadius != undefined) {
            // Assume same size for destination image as for src, and compute where the origin will fall
            var xDstImage = Math.floor(xSrcImage + rt * Math.sin(twist));
            var yDstImage = Math.floor(ySrcImage - rb * Math.sin(bend));
            deltax = xDstImage - xSrcImage;
            deltay = yDstImage - ySrcImage;
            // Setup feathering
            var a = width / 2;
            var b = height / 2;
            var fudge = Math.round(width/40) - 1;
            var xp = width - 5 - fudge; // 5 pixel feathering
            var xpp = width - fudge; // but don't consider very edge pixels, at least in hi res
            var vp = (xp-a)*(xp-a)/(a*a);
            var vpp = (xpp-a)*(xpp-a)/(a*a);
            // Main loop
            var xDstGlobal,yDstGlobal,xSrcGlobalZ,ySrcGlobalZ,xSrcGlobal,ySrcGlobal,xSrc,ySrc,x1Src,x2Src,y1Src,y2Src,offSrc1,offSrc2,offSrc3,offSrc4,rint,gint,bint,aint;
            var offDst = 0;
            for (var yDst = 0; yDst < height; yDst++) {
                for (var xDst = 0; xDst < width; xDst++) {
                    xDstGlobal = xDst + 0.001 - width/2 + deltax ;
                    yDstGlobal = yDst + 0.001 - height/2 + deltay;
                    // z-rotate on an elliptic sphere with radius rb, rt
                    xSrcGlobalZ = rt * Math.sin(Math.asin(xDstGlobal/rt) - twist);
                    ySrcGlobalZ = rb * Math.sin(Math.asin(yDstGlobal/rb) + bend);
                    xSrcGlobal = m[0] * xSrcGlobalZ + m[2] * ySrcGlobalZ + m[4];
                    ySrcGlobal = m[1] * xSrcGlobalZ + m[3] * ySrcGlobalZ + m[5];
                    xSrc = xSrcGlobal + width/2;
                    ySrc = ySrcGlobal + height/2;
                    // bilinear interpolation - https://en.wikipedia.org/wiki/Bilinear_interpolation
                    x1Src = Math.max(Math.min(Math.floor(xSrc), width-1), 0);
                    x2Src = Math.max(Math.min(Math.ceil(xSrc), width-1), 0);
                    y1Src = Math.max(Math.min(Math.floor(ySrc), height-1), 0);
                    y2Src = Math.max(Math.min(Math.ceil(ySrc), height-1), 0);
                    if (x1Src == x2Src) {
                        if (x1Src == 0) x2Src++; else x1Src--;
                    }
                    if (y1Src == y2Src) {
                        if (y1Src == 0) y2Src++; else y1Src--;
                    }
                    // ImageData pixel ordering is RGBA
                    offSrc1 = y1Src*4*width + x1Src*4;
                    offSrc2 = y1Src*4*width + x2Src*4;
                    offSrc3 = y2Src*4*width + x1Src*4;
                    offSrc4 = y2Src*4*width + x2Src*4;
                    rint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+0] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+0] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+0] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+0]);
                    gint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+1] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+1] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+1] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+1]);
                    bint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+2] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+2] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+2] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+2]);
                    var alpha;
                    if (process == 1) {
                        var v = (xDst-a)*(xDst-a)/(a*a) + (yDst-b)*(yDst-b)/(b*b);
                        if (v > vpp) 
                            alpha = 0;
                        else if (v >= vp && v <= vpp) 
                            alpha = Math.round(255 * ((Math.sqrt(vpp) - Math.sqrt(v))/(Math.sqrt(vpp) - Math.sqrt(vp))));
                        else
                            alpha = 255;
                    }
                    else if (process == 2) {
                        alpha = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+3] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+3] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+3] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+3]);
                        if (yDst < height/10)
                            alpha = Math.min(alpha, yDst /  (height/10) * 255);
                    }
                    else {
                        alpha = 255;
                    }
                    target.data[offDst] = rint; offDst++;
                    target.data[offDst] = gint; offDst++;
                    target.data[offDst] = bint; offDst++;
                    target.data[offDst] = alpha; offDst++;
                }
            }
        }
        else if (process == 2) {
            // Main loop
            var xSrc,ySrc,x1Src,x2Src,y1Src,y2Src,offSrc1,offSrc2,offSrc3,offSrc4,rint,gint,bint,aint;
            var offDst = 0;
            for (var yDst = 0; yDst < height; yDst++) {
                for (var xDst = 0; xDst < width; xDst++) {
                    xSrc = xDst;
                    ySrc = yDst - (lowerJaw * lowerJawDisplacement * yDst / height);
                    x1Src = Math.max(Math.min(Math.floor(xSrc), width-1), 0);
                    x2Src = Math.max(Math.min(Math.ceil(xSrc), width-1), 0);
                    y1Src = Math.max(Math.min(Math.floor(ySrc), height-1), 0);
                    y2Src = Math.max(Math.min(Math.ceil(ySrc), height-1), 0);
                    if (x1Src == x2Src) {
                        if (x1Src == 0) x2Src++; else x1Src--;
                    }
                    if (y1Src == y2Src) {
                        if (y1Src == 0) y2Src++; else y1Src--;
                    }
                    offSrc1 = y1Src*4*width + x1Src*4;
                    offSrc2 = y1Src*4*width + x2Src*4;
                    offSrc3 = y2Src*4*width + x1Src*4;
                    offSrc4 = y2Src*4*width + x2Src*4;
                    rint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+0] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+0] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+0] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+0]);
                    gint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+1] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+1] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+1] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+1]);
                    bint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+2] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+2] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+2] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+2]);
                    var alpha;
                    alpha = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+3] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+3] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+3] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+3]);
                    if (yDst < height/10)
                        alpha = Math.min(alpha, yDst /  (height/10) * 255);
                    target.data[offDst] = rint; offDst++;
                    target.data[offDst] = gint; offDst++;
                    target.data[offDst] = bint; offDst++;
                    target.data[offDst] = alpha; offDst++;
                }
            }
        }
        canvasTransformDst[process-1].getContext('2d').putImageData(target, 0, 0);
        return {x:deltax, y:deltay};
    }
    
    function updateGlobalTransform(sway, canvas) {
        var width = canvas.width;
        var height = canvas.height;
        var swayLength = animData.swayLength;
        var swayBorder = animData.swayBorder;
        var swayProcess = animData.swayProcess||1;
        // 0 2 4 
        // 1 3 5
        var m = [1, 0, 0, 1, 0, 0];
        var m1 = [1, 0, 0, 1, 0, 0];
        var m2 = [1, 0, 0, 1, 0, 0];
        var hipx;
        if (swayProcess == 1) { // note sway expressed in radians throughout
            // pivot around a point swayLength below image center, around where hips would be (assumes sitting)
            addXForm(1, 0, 0, 1, 0, -swayLength, m);
            addXForm(Math.cos(sway), Math.sin(sway), -Math.sin(sway), Math.cos(sway), 0, 0, m);
            addXForm(1, 0, 0, 1, 0, swayLength, m);
        } 
        else if (swayProcess == 2) {
            // assume character centered vertically with feet at or near bottom - use m1 from a point at the bottom to sway bottom half of iamge one way,
            // compute that hip displacement hipx, then use m1 to sway the top half in half the amount, shifted by hipx, the other way. Interpolate in the middle.
            addXForm(1, 0, 0, 1, 0, -height/2, m2);
            addXForm(Math.cos(-sway), Math.sin(-sway), -Math.sin(-sway), Math.cos(-sway), 0, 0, m2);
            addXForm(1, 0, 0, 1, 0, height/2, m2);
            hipx = height/2 * Math.tan(sway);
            addXForm(1, 0, 0, 1, 0, 0, m1);
            addXForm(Math.cos(sway/2), Math.sin(sway/2), -Math.sin(sway/2), Math.cos(sway/2), 0, 0, m1);
            addXForm(1, 0, 0, 1, 0, 0, m1);
        }
        var overhang = (animData.clothingOverhang||0);
        var source = canvasTransformSrc["G"].getContext('2d', {willReadFrequently:true}).getImageData(0, 0, width, height + overhang);
        var target = canvas.getContext('2d', {willReadFrequently:true}).createImageData(width, height);
        var xDstGlobal,yDstGlobal,xSrcGlobal,ySrcGlobal;
        var xSrc,ySrc,x1Src,x2Src,y1Src,y2Src,offSrc1,offSrc2,offSrc3,offSrc4,rint,gint,bint,aint;
        var offDst = 0;
        var a = []; // optimize inner loop
        for (var xDst = 0; xDst < width; xDst++) {
            a[xDst] = breath*(Math.cos(xDst*2*Math.PI/width)/2 + 0.5);
        }
        for (var yDst = 0; yDst < height; yDst++) {
            for (var xDst = 0; xDst < width; xDst++) {
                if (swayBorder && (xDst < swayBorder || xDst > width-swayBorder)) { // optimization - our body characters have a lot of blank space on sides
                    target.data[offDst] = 0; offDst++;
                    target.data[offDst] = 0; offDst++;
                    target.data[offDst] = 0; offDst++;
                    target.data[offDst] = 0; offDst++;
                    continue;
                }
                xDstGlobal = xDst + 0.001 - width/2;
                yDstGlobal = yDst + 0.001 - height/2;
                if (swayProcess == 1) {
                    xSrcGlobal = m[0] * xDstGlobal + m[2] * yDstGlobal + m[4];
                    ySrcGlobal = m[1] * xDstGlobal + m[3] * yDstGlobal + m[5];
                }
                else if (swayProcess == 2) {
                    var overlap = height/10; // vertical distance from height/2 in which we interpolate between the two transforms
                    if (yDst < height/2 - overlap) {
                        xSrcGlobal = -hipx + m1[0] * xDstGlobal + m1[2] * yDstGlobal + m1[4];
                        ySrcGlobal = m1[1] * xDstGlobal + m1[3] * yDstGlobal + m1[5];
                    }
                    else if (yDst < height/2 + overlap) {
                        var xSrcGlobal1,ySrcGlobal1,xSrcGlobal2,ySrcGlobal2;
                        xSrcGlobal1 = -hipx + m1[0] * xDstGlobal + m1[2] * yDstGlobal + m1[4];
                        ySrcGlobal1 = m1[1] * xDstGlobal + m1[3] * yDstGlobal + m1[5];
                        xSrcGlobal2 = m2[0] * xDstGlobal + m2[2] * yDstGlobal + m2[4];
                        ySrcGlobal2 = m2[1] * xDstGlobal + m2[3] * yDstGlobal + m2[5];
                        var f = (yDst - (height/2 - overlap)) / (overlap * 2);
                        xSrcGlobal = xSrcGlobal1*(1-f) + xSrcGlobal2*f;
                        ySrcGlobal = ySrcGlobal1*(1-f) + ySrcGlobal2*f;
                    }
                    else {
                        xSrcGlobal = m2[0] * xDstGlobal + m2[2] * yDstGlobal + m2[4];
                        ySrcGlobal = m2[1] * xDstGlobal + m2[3] * yDstGlobal + m2[5];
                    }
                }
                xSrc = xSrcGlobal + width/2;
                ySrc = ySrcGlobal + height/2;
                ySrc -= a[xDst];
                x1Src = Math.max(Math.min(Math.floor(xSrc), width-1), 0);
                x2Src = Math.max(Math.min(Math.ceil(xSrc), width-1), 0);
                y1Src = Math.max(Math.min(Math.floor(ySrc), height+overhang-1), 0);
                y2Src = Math.max(Math.min(Math.ceil(ySrc), height+overhang-1), 0);
                if (x1Src == x2Src) {
                    if (x1Src == 0) x2Src++; else x1Src--;
                }
                if (y1Src == y2Src) {
                    if (y1Src == 0) y2Src++; else y1Src--;
                }
                offSrc1 = y1Src*4*width + x1Src*4;
                offSrc2 = y1Src*4*width + x2Src*4;
                offSrc3 = y2Src*4*width + x1Src*4;
                offSrc4 = y2Src*4*width + x2Src*4;
                rint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+0] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+0] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+0] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+0]);
                gint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+1] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+1] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+1] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+1]);
                bint = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+2] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+2] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+2] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+2]);
                var alpha;
                alpha = Math.round((x2Src-xSrc)*(y2Src-ySrc) * source.data[offSrc1+3] + (xSrc-x1Src)*(y2Src-ySrc) * source.data[offSrc2+3] + (x2Src-xSrc)*(ySrc-y1Src) * source.data[offSrc3+3] + (xSrc-x1Src)*(ySrc-y1Src) * source.data[offSrc4+3]);
                target.data[offDst] = rint; offDst++;
                target.data[offDst] = gint; offDst++;
                target.data[offDst] = bint; offDst++;
                target.data[offDst] = alpha; offDst++;
            }
        }
        canvas.getContext('2d').putImageData(target, 0, 0);
    } 
    
    function addXForm(a, b, c, d, e, f, m) {
        // a c e   ma mc me
        // b d f . mb md mf  
        // 0 0 1   0  0  1 
        m[0] = a * m[0] + c * m[1];     m[2] = a * m[2] + c * m[3];     m[4] = a * m[4] + c * m[5] + e; 
        m[1] = b * m[0] + d * m[1];     m[3] = b * m[2] + d * m[3];     m[5] = b * m[4] + d * m[5] + f;
    }
    
    function getIdles() {
        if (idleType == "none") 
            return [];
        else if (idleData) {
            var a = [];
            for (var i = 0; i < idleData[idleType].length; i++) {
                var s = idleData[idleType][i];
                var m = s.match(/([a-z]+)([0-9]+)-([0-9]+)/);
                if (m) {
                    for (var i = parseInt(m[2]); i <= parseInt(m[3]); i++)
                        a.push(m[1] + i);
                }
                else {
                    a.push(s);
                }
            }
            return a;
        }
        else {
            console.log("missing idleData");
            return [];
        }
    }

    //
    // 3D
    //
    
    function setup3d() {
        scene = new THREE.Scene();
        
        var canvas = document.getElementById(divid + "-canvas");
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
        // You can use this event to override the 3d settings
        var e = createEvent("setup3d", {scene:scene, camera:camera, model:model});
        document.getElementById(divid).dispatchEvent(e);
        if (!e.defaultPrevented) {
            // Adjust model scale and position
            model.scale.set(animData.modelScale, animData.modelScale, animData.modelScale);
            model.position.y = animData.modelPosY;
            // Adjust camera position
            camera.position.x = 0;
            camera.position.y = animData.cameraPosY;
            camera.position.z = animData.cameraPosZ;
            camera.rotation.x = THREE.Math.degToRad(animData.cameraRotX);
            // Add lighting
            var light = new THREE.AmbientLight( Number("0x"+animData.ambientColor), animData.ambientIntensity );
            scene.add(light);
            light = new THREE.DirectionalLight(Number("0x"+animData.light1Color), animData.light1Intensity );
            light.position.set(0, 0, 10);            
            scene.add(light);
            light = new THREE.DirectionalLight(Number("0x"+animData.light2Color), animData.light2Intensity );
            light.position.set(-10, 0, 0);            
            scene.add(light);
            light = new THREE.DirectionalLight(Number("0x"+animData.light3Color), animData.light3Intensity );
            light.position.set(10, 0, 0);            
            scene.add(light);
        }
        scene.add(model);
        renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
        camera.aspect = canvas.clientWidth / canvas.clientHeight;
        camera.updateProjectionMatrix();
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

        if (loaded && !loading && !animating && !playShield && !atLeastOneLoadError) {
            if (timeSinceLastAction > 1500 + Math.random() * 3500) {  // no more than 5 seconds with no action whatsoever
                timeSinceLastAction = 0;
                var idles = getIdles();
                var hasBlinkIdle = idles.length > 0 && idles[0] == "blink"; // if blink is the first idle then it is expected to be randomly interleaved with the other idles on it's own schedule
                // There WILL be an action - will it be a blink? Blinks must occur at a certain frequency. But hd characters incorporate blink into idle actions.
                if (hasBlinkIdle && timeSinceLastBlink > 5000 + Math.random() * 5000) {
                    timeSinceLastBlink = 0;
                    execute("blink", "", null, null, true, onIdleComplete.bind(null));
                }
                // Or another idle routine?
                else {
                    if (hasBlinkIdle) idles.shift();
                    var idle = null;
                    // pick an idle that does not repeat - favor the first idle listed first - give us a chance to start with something quick/important to fetch
                    if (idles.length > 0) {
                        if (!lastIdle) { 
                            idle = idles[0];
                        }
                        else {
                            for (var guard = 10; guard > 0; guard--) {
                                idle = idles[Math.floor(Math.random() * idles.length)];
                                if (idle == lastIdle) continue;
                                break;
                            }
                        }
                    }
                    if (idle) {
                        lastIdle = idle;
                        execute(idle, "", null, null, true, onIdleComplete.bind(null));
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

    function updateSway(framesSway) {
        if (swayTarget == undefined || Math.abs(sway - swayTarget) < 0.001) {
            if (that.playing()) {
                swayTarget = -animData.normalSwayRange + Math.random() * animData.normalSwayRange * 2;
                swayAccel = animData.normalSwayAccelMin + (animData.normalSwayAccelMax - animData.normalSwayAccelMin) * Math.random();
            }
            else {
                swayTarget = -animData.idleSwayRange + Math.random() * animData.idleSwayRange * 2;
                swayAccel = animData.idleSwayAccelMin + (animData.idleSwayAccelMax - animData.idleSwayAccelMin) * Math.random();
            }
        }
        while (framesSway > 0) {
            sway += (swayTarget - sway) * swayAccel;
            framesSway--;
        }
    }

    function updateBreath() {
        breath = (animData.shoulderDisplacement||0) * Math.max(0, Math.sin(breathTime * 2 * Math.PI / animData.breathCycle));
        breathTime += fpsInterval;
    }

    //
    // Misc
    //

    function createEvent(s, o) {
        if(typeof(Event) === 'function') {
            return new CustomEvent(s, {detail:o, cancelable:true});
        } 
        else {
            // For IE
            var event = document.createEvent('Event');
            event.initCustomEvent(s, false, false, o);
            return event;
        }
    }

    start();
}
