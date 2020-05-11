# Media Semantics Character API Reference Implementation
HTML 5 Talking Avatar using Character API and AWS Polly

## Overview
This is the Reference Implementation for the [Character API](https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ), a cloud-based Character Animation API available on the Amazon AWS Marketplace.

For a detailed introduction to the Character API, please read the [Character API Tutorial](https://www.mediasemantics.com/apitutorial.html). 

You can see the Reference Implementation running [here](https://mediasemantics.com/charapiclient.html). 

## Requirements
This README assumes that you are able to view html pages using a local web server (i.e. using a url that begins with http://localhost) and that you are able to run Node.js. 
If you prefer, you can also install it directly on a web server. Please see this [tutorial](https://www.mediasemantics.com/apitutorial2.html) for tips on
setting up an AWS EC2 instance using Apache and Node.js.

## Obtaining keys
Use this [AWS Markeplace](https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ) page to add the
Character API service to your AWS account. You will receive codes by email that you will insert in the server.js file. You will be charged $0.007 per call to the Character API. There are no monthly minimums. 
Charges will appear on your monthly AWS bill. The Character API access key is the 8-digit key that is mailed to you when you add the Character API to your AWS account. 

This sample uses the Amazon Polly Text-to-Speech API, which is also priced based on usage. 
Since this sample caches the API results, API fees are only incurred for text that has not already been seen, so your actual spend depends on your traffic and on the effectiveness of the cache.

To access the AWS Polly Text-to-Speech service, you will want to create an IAM User for your app. On the AWS Console, go to the IAM service and click Add User. You might call the user "polly".
Select the "Programmatic access" checkbox and click Next. Click "Attach existing policies directly". In the Policy Type search box, enter "polly", then check the box beside AmazonPollyFullAccess. Click Next.
Review the details, then click "Create user". On the next screen, you will want to copy two strings. The Access key ID is a string of capitalized alphanumeric characters, and the Secret Access Key is longer string
of mixed-case characters. Make sure you record both values, as you will need to insert them into the sample.

## Installation
Install the sample in a directory on the server, e.g. the home directory:
```
cd ~  
git clone https://github.com/mediasemantics/charapi.git  
cd charapi
```

Install the required dependencies:
```
npm update
```

Create a cache subdirectory:
```
mkdir cache
```

Modify the server.js file to add your Character API and AWS Polly access credentials.
```
nano server.js
```
Replace 'xxxxxxxx' with the 8 digit key that was mailed to you when you signed up for the Character API.

Replace 'xxxxxxxxxxxxxxxxxxxx' and 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' with the values obtained when you created the 'polly' IAM user.

Save your changes.

You can now start the server with:
```
node server.js
```
You should see "Listening on port 3000".

You can verify that the caching server app is working by viewing this URL from a web browser:
```
http://localhost:3000/animate
```
You should see an image appear.

Finally, load charapiclient.html into a web browser using the appropriate http://localhost url (the sample will not run using a file url).

## How it works

The page uses the charapiclient.js library to create an animated character. This library calls the animate endpoint on the caching server,
which in turn calls the Character API and Polly as required to replenish its cache.

The character acts like a puppet. Without any input, it exhibits an "idle" behavior. 
By examining the code in charapiclient.html, you will see that you can prompt it to say different things by invoking the dynamicPlay() function.
Each call to dynamicPlay consists of a do/say pair representing a string to be spoken and a manner in which to speak it. You can also use 
a 'do' by itself to perform a silent action, or a 'say' by itself to speak with no deliberate action.

```
dynamicPlay({do:'look-right', say:'Look over here.'})
```

If an item is already playing then dynamicPlay calls are queued up for playback. If you have a lot of text to play, then we recommend that you break it up into multiple 
dynamicPlay() calls of approximately one sentence each. This allows the synthesis to be performed a little at a time, so the user can 
begin listening with minimal delay, while more is being preloaded.

Please see [Character API Tutorial](https://www.mediasemantics.com/apitutorial.html) for a detailed introduction to the Character API and additional tips 
for building solutions based on the Reference Implementation.




