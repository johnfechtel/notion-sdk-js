
const dotenv = require("dotenv")
const { Octokit } = require("octokit")
const _ = require("lodash")

dotenv.config()
const octokit = new Octokit({ auth: process.env.GITHUB_KEY })

getIssues()

async function getIssues(){
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
				})
			}
		}
	}

    var filter = 81

    for (const issue of issues) {
        if (issue.number < filter) {
            console.log(`deleting issue ${issue.number}`)
            await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}', {
                owner: process.env.GITHUB_REPO_OWNER,
                repo: process.env.GITHUB_REPO_NAME,
                issue_number: issue.number
            })

        }
    }

	console.log(`${issues.length} Github issues retrieved.`)
	return issues

}


