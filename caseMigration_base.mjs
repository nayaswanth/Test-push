import request from 'request';
import jsforce from 'jsforce';
import fs from 'fs';


var legacyConnection = new jsforce.Connection({
    loginUrl: 'https://login.salesforce.com'
});

var leadtocashConnection = new jsforce.Connection({
    loginUrl: 'https://login.salesforce.com'
});

async function salesforceLogins() {
    await legacyConnection.login('<username>', '<password>');
    console.log ('Legacy logged in');
    await leadtocashConnection.login('<username>', '<password>');
    console.log ('LTC logged in');
}

async function retrieveLegacyCases() {
    let queryResults = await legacyConnection
        .sobject("Case")
        .select ("Id,CaseNumber, Sales_Instance_Case_Id__c")
        .include('ContentDocumentLinks')
        .select("Id,ContentDocument.*")
        .where ("ContentDocument.ContentSize > 500")
        .end()
        .where("Sales_Instance_Case_Id__c <> '' and Id in ('<Case IDS>')")
        .execute({ autoFetch : true, maxFetch : 100000});    

    console.log (`Legacy cases ${queryResults.length}`);
    return queryResults;
}

async function retrieveLTCCase(legacyCase) {
    let queryResults = await leadtocashConnection
        .sobject("Case")
        .select ("Id, CaseNumber")
        .include('ContentDocumentLinks')
        .select("Id,ContentDocument.*")
        .end()
        .where(`Id = '${legacyCase.Sales_Instance_Case_Id__c}'`)
        .execute({ autoFetch : true, maxFetch : 10});    

    return queryResults[0];
}

async function retrieveLatestContentVersion(contentDocumentLink) {
    let queryResults = await legacyConnection
        .sobject("ContentVersion")
        .select ("Id, Title, FileExtension")
        .where(`ContentDocumentId = '${contentDocumentLink.ContentDocument.Id}' and IsLatest = true`)
        .execute({ autoFetch : true, maxFetch : 10});    

    return queryResults[0];
}

function downloadFile(contentVerion) {
    return new Promise((resolve, reject) => {
        //let fileName = `${contentVerion.Title.replace(/:|\/|\*|\t/g, '_')}.${contentVerion.FileExtension}`;
        let fileName = `${contentVerion.Title.replace(/:|\/|\*|\t/g, '_')}`;
        if (contentVerion.FileExtension) {
            fileName += `.${contentVerion.FileExtension}`;
        }
    
        let fileOut = fs.createWriteStream(fileName);
        legacyConnection.sobject('ContentVersion').record(contentVerion.Id).blob('VersionData').pipe(fileOut);
        fileOut.on('close',() => {
            resolve();
        });
        fileOut.on("error", reject);
    });
}

function uploadLargeFile (metadata, file) {
    return new Promise((resolve, reject) => {
        request.post({
          url: leadtocashConnection.instanceUrl + '/services/data/v55.0/sobjects/ContentVersion',
          auth: {
            bearer: leadtocashConnection.accessToken
          },
          formData: {
            entity_content: {
              value: JSON.stringify(metadata),
              options: {
                contentType: 'application/json'
              }
            },
            VersionData: {
              value: file,
              options: {
                filename: metadata.PathOnClient,
                contentType: 'application/octet-stream'
              }
            }
          }
        }, (err, response) => {
            if (err)
              reject(err)
      
            resolve(JSON.parse(response.body))
          })
    });
}

async function uploadFile(ltcCase, legacyContentVerion) {
    let fileName = `${legacyContentVerion.Title.replace(/:|\/|\*|\t/g, '_')}`;
    if (legacyContentVerion.FileExtension) {
        fileName += `.${legacyContentVerion.FileExtension}`;
    }
    let fileOnDisk = await fs.promises.readFile(fileName);

    let cvRecord = {
        PathOnClient : fileName,
        FirstPublishLocationId : ltcCase.Id,
        Title : `${legacyContentVerion.Title.replace(/:|\/|\*|\t/g, '_')}`,
        Description : `Migrated Case file`
      };
    await uploadLargeFile (cvRecord, fileOnDisk);
}

async function deleteFile(legacyContentVerion) {
    await fs.promises.unlink(`${legacyContentVerion.Title.replace(/:|\/|\*|\t/g, '_')}.${legacyContentVerion.FileExtension}`);
}

async function duplicateFiles(legacyCase, ltcCase) {
    for (const cdl of legacyCase.ContentDocumentLinks.records) {
        let latestVersion = await retrieveLatestContentVersion(cdl);
        if (latestVersion) {
            let existingLtcFile = undefined;
            if (ltcCase.ContentDocumentLinks) {
                existingLtcFile = ltcCase.ContentDocumentLinks.records.find (cdl => cdl.ContentDocument.Title == latestVersion.Title && cdl.ContentDocument.FileExtension == latestVersion.FileExtension);
            }
            if (!existingLtcFile) {
                await downloadFile(latestVersion);
                await uploadFile(ltcCase, latestVersion);
                await deleteFile(latestVersion);                
            }
            else {
                console.log (`${latestVersion.Title.replace(/:|\/|\*|\t/g, '_')}.${latestVersion.FileExtension} already exists for LTC Case ${ltcCase.CaseNumber}`);
            }
        }
    }
}

async function processCases(cases) {
    let errorsEncountered = [];
    for (const legacyCase of cases) {
        if (legacyCase.ContentDocumentLinks && legacyCase.ContentDocumentLinks.records) {
            let ltcCase = await retrieveLTCCase(legacyCase);
            if (ltcCase){
                console.log (`Need to migrate ${legacyCase.ContentDocumentLinks.records.length} file(s) for Legacy Case/LTC Case ${legacyCase.CaseNumber}/${ltcCase.CaseNumber}`);
                try {
                    await duplicateFiles(legacyCase, ltcCase);
                }
                catch(error) {
                    errorsEncountered.push(legacyCase.Id + '|' + ltcCase.Id);
                }
            }
            else {
                errorsEncountered.push(`No LTC Case found for ${legacyCase.CaseNumber}`);
            }
        }
    }   
    
    if (errorsEncountered.length > 0) {
        console.log (`Could not migrate ${errorsEncountered.length} files`);
        errorsEncountered.forEach( errorMsg => console.log (errorMsg));
    }
}

async function migrateFiles() {
    await salesforceLogins();
    let cases = await retrieveLegacyCases();
    await processCases(cases);
    console.log('Done');
}

migrateFiles();