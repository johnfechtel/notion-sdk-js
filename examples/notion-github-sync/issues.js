const { Client } = require("@notionhq/client")
const dotenv = require("dotenv")
const { Octokit } = require("octokit")
const _ = require("lodash")

dotenv.config()
const octokit = new Octokit({ auth: process.env.GITHUB_KEY })
const notion = new Client({ auth: process.env.NOTION_KEY })

const databaseId = process.env.NOTION_DATABASE_ID
const relationId = process.env.NOTION_FEATURES_DB
const OPERATION_BATCH_SIZE = 10

runIntegration()

async function runIntegration() {

	const notionPages = await getNotionPages()
	const githubIssues = await getGithubIssues()

	const githubIdToNotion = await mapPagesToIssues(notionPages);

	synchronize(notionPages, githubIssues, githubIdToNotion)

}



// ======== ITERATING ======== 
async function synchronize(notionPages, githubIssues, githubIdToNotion) {

	console.log(`synchronize()`)

	const pagesToCreate = []
	const pagesToUpdate = []
	const issuesToCreate = []
	const issuesToUpdate = []

	// Check Notion pages
	// 		if a new Notion page, create Github issue
	// 		if an existing, check Github issue for most uptodate
	for (page of notionPages) {
		// temporary for testing
		// issuesToUpdate.push(page)

		if (page.issueNumber == -1) {
			issuesToCreate.push(page)
			console.log(`  need to create Github: ${page.id}`)
		}
	}

	// Check Github issues
	// 		if a new Github issue, create new Notion page
	for (issue of githubIssues) {
		const pageId = githubIdToNotion[issue.number]

		if (!pageId) {
			pagesToCreate.push(issue)
			console.log(`  need to create Notion: ${issue.number}`)
		} else {
			pagesToUpdate.push({
				...issue,
				pageId,
			})
			console.log(`  need to update Notion: ${issue.number}`)
		}
	}

	await createNotionPages(pagesToCreate)
	await updateNotionPages(pagesToUpdate, githubIssues)
	await createGithubIssues(issuesToCreate)
	// await updateGithubIssues(issuesToUpdate, notionPages)
}


// ======== CREATION/UPDATING ======== 
async function updateNotionPages(pages, allIssues) {
	console.log(`updateNotionPages()`)

	const pagesToUpdateChunks = _.chunk(pages, OPERATION_BATCH_SIZE)
	for (const pagesToUpdateBatch of pagesToUpdateChunks) {
		await Promise.all(
			pagesToUpdateBatch.map(({ pageId, ...issue }) =>
				notion.pages.update({
					page_id: pageId,
					properties: getPropertiesFromIssue(issue),
				})
			)
		)
		// console.log(`Completed batch size: ${pagesToUpdateBatch.length}`)
	}

}

async function updateGithubIssues(pages, allPages) {
	console.log(`updateGithubIssues()`)

	const milestones = await octokit.request('GET /repos/{owner}/{repo}/milestones', {
		owner: process.env.GITHUB_REPO_OWNER,
		repo: process.env.GITHUB_REPO_NAME
	})
}

async function createNotionPages(issues) {
	console.log(`createNotionPage()`)

	const pagesToCreateChunks = _.chunk(issues, OPERATION_BATCH_SIZE)
	for (const pagesToCreateBatch of pagesToCreateChunks) {
		await Promise.all(
			pagesToCreateBatch.map(issue =>
				notion.pages.create({
					parent: { database_id: databaseId },
					properties: getPropertiesFromIssue(issue),
				})
			)
		)
		// console.log(`Completed batch size: ${pagesToCreateBatch.length}`)
	}
}

async function createGithubIssues(pages) {
	console.log(`createGithubIssues()`)

	const milestones = await octokit.request('GET /repos/{owner}/{repo}/milestones', {
		owner: process.env.GITHUB_REPO_OWNER,
		repo: process.env.GITHUB_REPO_NAME
	})


	for (const page of pages) {
		const milestone = await returnMilestone(page, milestones)
		const labels = []
		const features = await returnFeatures(page)
		const entryType = await returnEntryType(page)
		const priority = await returnPriority(page)
		const points = await returnPoints(page)
		
		labels.push(...features)
		labels.push(entryType)
		labels.push(priority)
		labels.push(points)

		console.log(`-> milestone: ${milestone}`)
		const newIssue = await octokit.request('POST /repos/{owner}/{repo}/issues', {
			owner: process.env.GITHUB_REPO_OWNER,
			repo: process.env.GITHUB_REPO_NAME,
			title: page.properties["Name"].title
				.map(({ plain_text }) => plain_text)
				.join(""),
			labels: labels,
			milestone: milestone

		})

		// console.log(newIssue)

		await setNewPageProperties(page, newIssue)
	}
}

async function setNewPageProperties(page, newIssue) {
	console.log(`setNewPageProperties(), pageId=${page.id}, issue=${newIssue.data.state}`)

	const response = await notion.pages.update({
		page_id: page.id,
		properties: {
			'GHID': {
				number: newIssue.data.number
			},
			Status: {
				select: { name: newIssue.data.state }
			}
		}
	})
}


// ======== RETRIEVAL ======== 
async function getNotionPages() {
	const pages = []
	let cursor = undefined
	while (true) {
		const { results, next_cursor } = await notion.databases.query({
			database_id: databaseId,
			start_cursor: cursor,
		})
		pages.push(...results)
		if (!next_cursor) {
			break
		}
		cursor = next_cursor
	}

	for (var i = 0; i < pages.length; i++) {
		pages[i].pageId = pages[i].id

		if (pages[i].properties["GHID"]) {
			// console.log(`->entry already exists.`)
			pages[i].issueNumber = pages[i].properties["GHID"].number
		} else {
			pages[i].issueNumber = -1
			// console.log(`->entry doesn't yet exist. Setting to -1`)
		}
	}

	console.log(`${pages.length} Notion pages retrieved.`)
	return pages
}

async function getNotionPageContent(page){
	// tbd

}

// https://octokitnet.readthedocs.io/en/latest/issues/
async function getGithubIssues() {
	const issues = []
	const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
		owner: process.env.GITHUB_REPO_OWNER,
		repo: process.env.GITHUB_REPO_NAME,
		state: "all",
		per_page: 100,
	})
	for await (const { data } of iterator) {
		for (const issue of data) {
			if (!issue.pull_request) {
				issues.push({
					number: issue.number,
					title: issue.title,
					state: issue.state,
					labels: issue.labels
				})
			}
		}
	}

	console.log(`${issues.length} Github issues retrieved.`)
	return issues
}


// ======== MAPPING ======== 
async function mapPagesToIssues(notionPages) {
	const pagesToIssues = {}
	for (const { pageId, issueNumber } of notionPages) {
		pagesToIssues[issueNumber] = pageId
		console.log(`ghId=${issueNumber}, pageId=${pageId}`)
	}

	return pagesToIssues
}

// ======== UTILITY ======== 
/**
 * Returns the GitHub issue to conform to this database's schema properties.
 *
 * @param {{ number: number, title: string, state: "Backlog" | "Ready for QA", comment_count: number, url: string }} issue
 */
function getPropertiesFromIssue(issue) {

	var stateName = ""

	const { title, number, state, comment_count, url } = issue
	if (state == "open") {
		stateName = "Backlog"
	} else {
		stateName = "Ready for QA"
	}
	return {
		Name: {
			title: [{ type: "text", text: { content: title } }],
		},
		"GHID": {
			number,
		},
		Status: {
			select: { name: stateName },
		},
	}
}

function getPropertiesFromPage(page) {
	return {
		title: page.properties["Name"]
	}
}

// ======== MILESTONES ======== 
async function returnMilestone(page, milestones){
	console.log(`returnMilestone()`)

	var milestoneId = -1
	const milestone = page.properties["Milestone"]
	
	if (milestone){

		// this is assuming there are multiple milestones associated
		for	(const rel of milestone.relation) {

			const relatedPage = await notion.pages.retrieve(
				{ page_id: rel.id 
			})

			// writeToLog(relatedPage, 'milestone')
			
			if (relatedPage.properties["GHID"].number == -1){
				
				var milestoneName = relatedPage.properties["Name"].title[0].plain_text
				
				const newGHID = await createNewGithubMilestone(milestoneName)
				const updateMilestone = await updateNotionMilestones(relatedPage, newGHID)
				
				milestoneId = newGHID

			} else{
				milestoneId = relatedPage.properties["GHID"].number
			}
			
		}


	}

	return milestoneId
}

async function createNewGithubMilestone(name){

	var number = -1
	try {
		const newMilestone = await octokit.request('POST /repos/{owner}/{repo}/milestones', {
			owner: process.env.GITHUB_REPO_OWNER,
			repo: process.env.GITHUB_REPO_NAME,
			title: name
		})

		number = newMilestone.data.number
		
	} catch (err) {
		console.error(err)

		
	}

	return number
}

async function updateNotionMilestones(milestone, newGHID){

	const response = await notion.pages.update({
		page_id: milestone.id,
		properties: {
			'GHID': {
				number: newGHID,
			}
		}
	})

	return response
}

// ======== FEATURES ========
async function returnFeatures(page) {
	// make map of existing features in github
	// for each feature associated with notion page
	// 	if it already exists, assign
	//  else create new feature, assign

	const features = []
	const labels = await getGithubLabels()

	const relatedFeatures = page.properties["Feature"]

	if (relatedFeatures) {

		for (const rel of relatedFeatures.relation) {
			const relatedPage = await notion.pages.retrieve({
				page_id: rel.id	
			})
			const name = relatedPage.properties["Name"].title[0].plain_text
			const title = `Feature/${name}`

			if (!labels[title]) {
				await createNewGithubLabel(name, 'Feature')
			}

			features.push(title)
		}
	}

	return features
}

// ======== ENTRY TYPE ========
async function returnEntryType(page) {
	const name = page.properties['Entry Type'].select.name
	const title = `Entry Type/${name}`
	await createNewGithubLabel(name, 'Entry Type')

	return title
}

// ======== PRIORITY ========
async function returnPriority(page) {
	const name = page.properties['Priority'].select.name
	const title = `Priority/${name}`
	await createNewGithubLabel(name, 'Priority')

	return title
}

// ======== POINTS ========
async function returnPoints(page) {
	const name = page.properties['Points'].select.name
	const title = `Points/${name}`
	await createNewGithubLabel(name, 'Points')

	return title
}


// ======== LABELS ========
async function getGithubLabels() {
	// returns map of all github features
	const githubLabels = {}

	const result = await octokit.request('GET /repos/{owner}/{repo}/labels', {
		owner: process.env.GITHUB_REPO_OWNER,
		repo: process.env.GITHUB_REPO_NAME
	})

	for (label in result) {
		githubLabels[label.name] = label.id
	}

	return githubLabels
}

async function createNewGithubLabel(name, type) {

	// I don't think I need to do this, does Github create a new label automatically?
	const title = `${type}/${name}`

	var color = ''
	var description = ''

	switch (type) {
		case 'Feature':
			color = 'FFA500'
			description = 'What software feature this issue relates to.'
			break
		case 'Entry Type':
			color = '1dab1d' 
			description = 'Whether this issue is a feature or a bug.'
			break
		case 'Priority':
			color = '69d2db'
			description = 'How important this issue is.'
			break
		case 'Points':
			color = 'db69d0'
			description = 'How long it is estimated this issue will take.'
			break
		default:
			color = '808080'
			description = 'Something went wrong.'
	}

	// this is lazy, but for some reason the github label map isn't working to catch pre-existing labels
	try {
		const result = await octokit.request('POST /repos/{owner}/{repo}/labels', {
			owner: process.env.GITHUB_REPO_OWNER,
			repo: process.env.GITHUB_REPO_NAME,
			name: title,
			color: color,
			description: description
		})
	} catch (error) {
		console.error(error)
	}

	// return result
}

// ======== HELP ======== 
function writeToLog(data, prefix){

	var jsonPage = JSON.stringify(data, null, 4)
	const fs = require('fs')
	fs.writeFile(`./logs/${prefix}_${Date.now()}.json`, jsonPage, (err) => {
		if (err) {
			console.log(err)
		}
	})

}