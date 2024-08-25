# Media Semantics Character API Reference Implementation
HTML 5 Talking Avatar using Character API and AWS Polly.

## Overview
This is the Reference Implementation for the [Character API](https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ), a cloud-based Character Animation API available on the Amazon AWS Marketplace.

For a detailed introduction to the Character API, please read the [Character API Tutorial](https://www.mediasemantics.com/apitutorial.html). 

You can see the Reference Implementation running [here](https://mediasemantics.com/charapiclient.html). 

## Requirements
This ReadMe describes how to install the project on your local machine. You must have NodeJS installed.
If you prefer, you can also install the server portion directly on a web server. Please see this [tutorial](https://www.mediasemantics.com/apitutorial2.html) for tips on setting up an AWS EC2 instance.

## Obtaining keys
Use the [AWS Markeplace](https://aws.amazon.com/marketplace/pp/B06ZY1VBFZ) page to add the
Character API service to your AWS account. You will receive credentials by email to log onto your API dashboard. There you will generate an API key that you will insert in the server.js file. You will be charged $0.007 per call to the Character API. There are no monthly minimums. 
Charges will appear on your monthly AWS bill. 

This sample uses the Amazon Polly Text-to-Speech API, which is also priced based on usage. 

Since this sample caches the API results, API fees are only incurred for text that has not already been seen, so your actual spend depends on your traffic and on the effectiveness of the cache.

To access the AWS Polly Text-to-Speech service, you will want to create an IAM User for your app. On the AWS Console, go to the IAM service, click Users and then "Create User". Provide a name, such as "github_sample".
Press Next. Select "Attach policies directly". Then, in the Permissions policies Search field, type "polly". Select the checkbox next to AmazonPollyFullAccess. Click Next. Optionally create a tag, then click Create User.
Next, click on the newly created user to open it, and click the "Security credentials" tab. Scroll down to the section labeled "Access keys" and press "Create access key". Click Other, then Next. Then press "Create access key".
You will want to copy two strings. The Access key ID is a string of capitalized alphanumeric characters, and the Secret Access Key is longer string
of mixed-case characters. Make sure you record both values, as you will need to insert them into the sample.

## Installing the Server

Install the sample in a directory on the server, e.g. the home directory:
```
cd ~  
git clone https://github.com/mediasemantics/charapi.git  
cd charapi
```

Install the required dependencies:
```
npm install
```

Create a cache subdirectory:
```
mkdir cache
```

Next, modify the server.js file to add your Character API and AWS Polly access credentials.

Replace 'xxxxxxxxxxxxxxxxxxxxxxxxx' with the 25 character API Key from the API Dashboard.

Replace 'xxxxxxxxxxxxxxxxxxxx' and 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' with the values obtained when you created the 'polly' IAM user.

Save your changes.

You can now start the server with:
```
node server.js
```
You should see "Listening on port 3000".

You can verify that the caching server app is working by viewing this URL from a web browser:
```
http://localhost:3000/animate?character=SusanHead&version=3.0
```
You should see a strange image appear (it is a texture map, and is not meant to be displayed directly.)

## Installing the HTML Client

The Reference Implementation uses the <a href="https://www.npmjs.com/package/@mediasemantics/character-api-client">character-api-client</a> available on npmjs.com. You can use this module for any application in which you are using live, animated characters together with HTML content.

Open a second command window in the html directory. Ensure the client module is installed.

```
cd ~/charapi/html
npm install
```

Then install and run a local file server.

```
npm install -g http-server
cd ~/charapi/html
http-server . -p 3001
```

Then point your browser to: http://localhost:3001/charapiclient.html

## Note on scaling

The reference server code uses disk-based cache and locking, for simplicity. However it is better to use a memory-based caching technology such as Redis. This also becomes essential if you are creating a scalable implementation using a load balancer with more than one server. The Reference Implementation includes commented-out code that is suitable for use with the Redis implementation in AWS Elasticache.

## Next steps

Learn more about how to control your character at the <a href="https://www.npmjs.com/package/@mediasemantics/character-api-client">character-api-client</a> readme.

