const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const Entities = require('html-entities');
const ejs = require('ejs');
const Haikunator = require('haikunator');
const { SourceControl, Jira } = require('jira-changelog');
const RegExpFromString = require('regexp-from-string');

const config = {
  jira: {
    api: {
      host: core.getInput('jira_host'),
      email: core.getInput('jira_email'),
      token: core.getInput('jira_token'),
    },
    baseUrl: core.getInput('jira_base_url'),
    ticketIDPattern: RegExpFromString(core.getInput('jira_ticket_id_pattern')),
    approvalStatus: core.getInput('approval_statuses').split(",").filter(x => x !== ""),
    excludeIssueTypes: core.getInput('exclude_issue_types').split(",").filter(x => x !== ""),
    approvalStatus: ['Done', 'Closed', 'Accepted'],
    excludeIssueTypes: [],
    includeIssueTypes: [],
  },
  sourceControl: {
    defaultRange: {
      from:  core.getInput('source_control_range_from'),
      to: core.getInput('source_control_range_to')
    }
  },
};



const template = `
<% tickets.all.forEach((ticket) => { %>
- [<%= ticket.key %>](<%= jira.baseUrl + '/browse/' + ticket.key %>) (<%= ticket.fields.issuetype.name %>):
  <%= ticket.fields.summary %>
<% }); -%>
<% if (!tickets.all.length) {%> ~ None ~ <% } %>
`;


function transformCommitLogs(config, logs) {
  let approvalStatus = config.jira.approvalStatus;
  if (!Array.isArray(approvalStatus)) {
    approvalStatus = [approvalStatus];
  }

  // Tickets and their commits
  const ticketHash = logs.reduce((all, log) => {
    log.tickets.forEach((ticket) => {
      all[ticket.key] = all[ticket.key] || ticket;
      all[ticket.key].commits = all[ticket.key].commits || [];
      all[ticket.key].commits.push(log);
    });
    return all;
  }, {});
  const ticketList = _.sortBy(Object.values(ticketHash), ticket => ticket.fields.issuetype.name);
  let pendingTickets = ticketList.filter(ticket => !approvalStatus.includes(ticket.fields.status.name));

  // Pending ticket owners and their tickets/commits
  const reporters = {};
  pendingTickets.forEach((ticket) => {
    const email = ticket.fields.reporter.emailAddress;
    if (!reporters[email]) {
      reporters[email] = {
        email,
        name: ticket.fields.reporter.displayName,
        slackUser: ticket.slackUser,
        tickets: [ticket]
      };
    } else {
      reporters[email].tickets.push(ticket);
    }
  });
  const pendingByOwner = _.sortBy(Object.values(reporters), item => item.user);

  // Output filtered data
  return {
    commits: {
      all: logs,
      tickets: logs.filter(commit => commit.tickets.length),
      noTickets: logs.filter(commit => !commit.tickets.length)
    },
    tickets: {
      pendingByOwner,
      all: ticketList,
      approved: ticketList.filter(ticket => approvalStatus.includes(ticket.fields.status.name)),
      pending: pendingTickets
    }
  }
}

async function main() {
  try {
    // Get commits for a range
    const source = new SourceControl(config);
    const jira = new Jira(config);

    const range = config.sourceControl.defaultRange;
    console.log(`Getting range ${range.from}...${range.to} commit logs`);
    const commitLogs = await source.getCommitLogs('./', range);

    console.log('Found following commit logs (showing summary only):');
    console.log(commitLogs.map(x => x.summary));

    console.log('Generating Jira changelog from commit logs, fix version is: ' + core.getInput('fix_version'));
    const changelog = await jira.generate(commitLogs, core.getInput('fix_version'), core.getInput('excluded_tickets'));

    console.log('Generating changelog message');
    const data = await transformCommitLogs(config, changelog);

    data.jira = {
      baseUrl: config.jira.baseUrl,
    };
    data.includePendingApprovalSection = core.getInput('include_pending_approval_section') === 'true';
    let userTicketsTemplate = core.getInput('tickets_template')
    const changelogMessage = ejs.render(userTicketsTemplate ? userTicketsTemplate : template, data);

    core.setOutput('changelog_message', changelogMessage);

  } catch (error) {
    core.setFailed(error.message);
  }
}

main();
