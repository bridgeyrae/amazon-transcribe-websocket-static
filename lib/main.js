const audioUtils        = require('./audioUtils');  // for encoding audio data as PCM
const crypto            = require('crypto'); // tot sign our pre-signed URL
const v4                = require('./aws-signature-v4'); // to generate our pre-signed URL
const marshaller        = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node    = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic               = require('microphone-stream'); // collect microphone input as a stream of raw bytes

// our converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);

// our global variables for managing state
let languageCode;
let region;
let sampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;

const aws = require('aws-sdk');
const fs = require('browserify-fs');
var entireAudio = [];
var fileTrackID = 0;
var s3ID;
var transcribed;
var params;
var dateObject;
var newDate;
var date;

AWS.config.region = 'us-west-2'; // Region
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: 'us-west-2:1d4cdf52-5287-4c4c-9f4b-16ac6e22616c',
});

var s3 = new AWS.S3();
var dynamo = new AWS.DynamoDB();

// check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
    // Use our helper method to show an error on the page
    showError('We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again.');

    // maintain enabled/distabled state for the start and stop buttons
    toggleStartStop();
}

//gets textarea and uploads to s3
$('#txt').click(function () {
    $('#error').hide();
    toggleStartStop(true);
    console.log($('#transcript').val());
    transcribed = $('#transcript').val();
    console.log(transcribed);
    uploadObject(transcribed);
});

$('#start-button').click(function () {
    $('#error').hide(); // hide any existing errors
    toggleStartStop(true); // disable start and enable stop button

    // set the language and region from the dropdowns
    setLanguage();
    setRegion();

    // first we get the microphone input from the browser (as a promise)...
    window.navigator.mediaDevices.getUserMedia({
            video: false,
            audio: true
        })
        // ...then we convert the mic stream to binary event stream messages when the promise resolves
        .then(streamAudioToWebSocket)
        .catch(function (error) {
            showError('There was an error streaming your audio to Amazon Transcribe. Please try again.');
            toggleStartStop();
        });
});

let streamAudioToWebSocket = function (userMediaStream) {
    //let's get the mic input from the browser, via the microphone-stream module
    micStream = new mic();
    micStream.setStream(userMediaStream);


    // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    let url = createPresignedUrl();

    //open up our WebSocket connection
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    // when we get audio data from the mic, send it to the WebSocket if possible
    socket.onopen = function() {
        micStream.on('data', function(rawAudioChunk) {
            // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
            let binary = convertAudioToBinaryMessage(rawAudioChunk);

            if (socket.OPEN)
                socket.send(binary);
        }
    )};

    // handle messages, errors, and close events
    wireSocketEvents();
}

function setLanguage() {
    languageCode = $('#language').find(':selected').val();
    if (languageCode == "en-US" || languageCode == "es-US")
        sampleRate = 44100;
    else
        sampleRate = 8000;
}

function setRegion() {
    region = $('#region').find(':selected').val();
}

function wireSocketEvents() {
    // handle inbound messages from Amazon Transcribe
    socket.onmessage = function (message) {
        //convert the binary event stream message to JSON
        let messageWrapper = eventStreamMarshaller.unmarshall(Buffer(message.data));
        let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
        if (messageWrapper.headers[":message-type"].value === "event") {
            handleEventStreamMessage(messageBody);
        }
        else {
            transcribeException = true;
            showError(messageBody.Message);
            toggleStartStop();
        }
    };

    socket.onerror = function () {
        socketError = true;
        showError('WebSocket connection error. Try again.');
        toggleStartStop();
    };

    socket.onclose = function (closeEvent) {
        micStream.stop();
        // the close event immediately follows the error event; only handle one.
        if (!socketError && !transcribeException) {
            if (closeEvent.code != 1000) {
                showError('</i><strong>Streaming Exception</strong><br>' + closeEvent.reason);
            }
            toggleStartStop();
        }
        //uploadObject(entireAudio);
    };
}

let handleEventStreamMessage = function (messageJson) {
    let results = messageJson.Transcript.Results;

    if (results.length > 0) {
        if (results[0].Alternatives.length > 0) {
            let transcript = results[0].Alternatives[0].Transcript;

            // fix encoding for accented characters
            transcript = decodeURIComponent(escape(transcript));

            // update the textarea with the latest result
            $('#transcript').val(transcription + transcript + "\n");

            // if this transcript segment is final, add it to the overall transcription
            if (!results[0].IsPartial) {
                //scroll the textarea down
                $('#transcript').scrollTop($('#transcript')[0].scrollHeight);

                transcription += transcript + "\n";
            }
        }
    }
}

let closeSocket = function () {
    if (socket.OPEN) {
        micStream.stop();

        // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
        let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
        let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
        socket.send(emptyBuffer);
    }
}

$('#stop-button').click(function () {
    closeSocket();
    toggleStartStop();
});

$('#reset-button').click(function (){
    $('#transcript').val('');
    transcription = '';
});

function toggleStartStop(disableStart = false) {
    $('#start-button').prop('disabled', disableStart);
    $('#stop-button').attr("disabled", !disableStart);
}

function showError(message) {
    $('#error').html('<i class="fa fa-times-circle"></i> ' + message);
    $('#error').show();
}

function convertAudioToBinaryMessage(audioChunk) {
    let raw = mic.toRaw(audioChunk);

    if (raw == null)
        return;

    // downsample and convert the raw audio bytes to PCM
    let downsampledBuffer = audioUtils.downsampleBuffer(raw, sampleRate);
    let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);
    entireAudio.push(pcmEncodedBuffer);
    // add the right JSON headers and structure to the message
    let audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

    //convert the JSON object + headers into a binary event stream message
    let binary = eventStreamMarshaller.marshall(audioEventMessage);

    return binary;
}

function getAudioEventMessage(buffer) {
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ':message-type': {
                type: 'string',
                value: 'event'
            },
            ':event-type': {
                type: 'string',
                value: 'AudioEvent'
            }
        },
        body: buffer
    };
}

function createPresignedUrl() {
    let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        'GET',
        endpoint,
        '/stream-transcription-websocket',
        'transcribe',
        crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
            'key': $('#access_id').val(),
            'secret': $('#secret_key').val(),
            'sessionToken': $('#session_token').val(),
            'protocol': 'wss',
            'expires': 15,
            'region': region,
            'query': "language-code=" + languageCode + "&media-encoding=pcm&sample-rate=" + sampleRate
        }
    );

}
//put entireAudio in parameter for audio
//uploads text object to S3
function uploadObject(transcribed) {

  console.log('we are uploading');
  date = getDate();

  s3.putObject({
    Bucket: "amazon-mic-files",
    Key: date + "test_file_transcribed", //update key with file name that is distinctive
    Body: transcribed
  },
  function(err,data){
    if (err) {
      console.log(err,err.stack);
    }
    else {
      console.log(data);
      if (data) {
        console.log(data['ETag']);
        s3ID=data['ETag'];

        params = {
          TableName: 'amazon-mic',
          Item: {CustomerID: {
            S: 'test-user'
          },
          course: {
            S: "newCourse"
          },
          Date: {
            S: date
          },
          S3ObjectID: {
            S: s3ID
          }
        }
      }
      //add timestamp corresponding to course, slide, course_version, date - when was course taken, location
        dynamo.putItem(params, function(err,dataDB) {
          if (err) {
            console.log(err,err.stack);
          }
          else {
            console.log(dataDB);
          }
        });
      }
    }
  });
/*
  var chunk;

  for (chunk in entireAudio) {
    s3.putObject({
      Bucket: "amazon-mic-files",
      Key: "testfile" + fileTrackID,
      Body: chunk,
      ContentType: "audio/mp3"
    },
    function(err,data) {
      if (err) {
        console.log(err,err.stack);
      }
      else {
        console.log(data);//this is where etag is - have to figure out how to parse.
        if (data) {
          console.log(data['ETag']);
          s3ID=data['ETag'];
          console.log(s3ID);
        }
      }

    });
    fileTrackID+=1;
  }
*/
};

function getDate() {
  dateObject = new Date();
  //month
  var month = dateObject.getMonth();
  month = month.toString();
  //get day in month
  var day = dateObject.getDate();
  day = day.toString();
  //year
  var year = dateObject.getFullYear();
  year = year.toString();
  //hour
  var hours = dateObject.getHours();
  hours = hours.toString();
  //minutes
  var mins = dateObject.getMinutes();
  mins = mins.toString();
  //seconds
  var secs = dateObject.getSeconds();
  secs = secs.toString();

  if (month < 12) {
    month += 1;
  }

  console.log("the month is " + month);
  console.log("the day is " + day);
  console.log("the year is " + year);
  console.log(month+day+year+hours+mins+secs);
  newDate = month+day+year+hours+mins+secs
  return newDate;
};
