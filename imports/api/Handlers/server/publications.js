import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
import Handlers from '../Handlers';
import Comments from '../../Comments/Comments';
import escapeRegExp from '../../../modules/regexescaper';
import Packages from '../../Packages/server/ServerPackages';
import axios from "axios";
import { bearerToken } from "./igdb-methods";

Meteor.publish(
  'handlers',
  function handlers(
    handlerTitleSearch = '',
    handlerOptionSearch = 'trend',
    handlerSortOrder = 'down',
    limit = 18,
    localHandlerIds = [],
    handlerTagSearch = '',
  ) {
    // Protect from Cannot read property 'length' of null
    const safeLocalHandlerIds = Array.isArray(localHandlerIds) ? localHandlerIds : [];
    const isSearchFromArray = safeLocalHandlerIds.length > 0;

    let sortObject = { trendScore: handlerSortOrder === 'up' ? 1 : -1 };

    if (handlerOptionSearch === 'hot') {
      sortObject = { stars: handlerSortOrder === 'up' ? 1 : -1 };
    }
    if (handlerOptionSearch === 'download') {
      sortObject = { downloadCount: handlerSortOrder === 'up' ? 1 : -1 };
    }
    if (handlerOptionSearch === 'latest' || handlerOptionSearch === 'unauthorized') {
      sortObject = { createdAt: handlerSortOrder === 'up' ? 1 : -1 };
    }
    if (handlerOptionSearch === 'report') {
      sortObject = { reports: handlerSortOrder === 'up' ? 1 : -1 };
    }
    if (handlerOptionSearch === 'alphabetical') {
      sortObject = { gameName: handlerSortOrder === 'up' ? -1 : 1 };
    }
    const searchInArraySelectorCondition = isSearchFromArray > 0 ? {_id: { $in: safeLocalHandlerIds } } : {};
    
    // Will either get an array or a string (first one). so if not array > make array ... is array > continue
    const tagSearches = Array.isArray(handlerTagSearch)
      ? handlerTagSearch
      : handlerTagSearch
        ? [handlerTagSearch]
        : [];
        
    const genreSearches = tagSearches.filter(
      tag => !tag.startsWith('support:') && !tag.startsWith('players:'),
    );
    const genreSelectorCondition = genreSearches.length
      ? { genres: { $all: genreSearches.map(genre => new RegExp(`^${escapeRegExp(genre)}$`, 'i')) } } //all = must have all, similar to steam/steamdb
      : {};

    const compatibilitySelectorConditions = [];
    if (tagSearches.includes('support:controller')) {
      compatibilitySelectorConditions.push({ playableControllers: true });
    }
    if (tagSearches.includes('support:KeyboardMouse')) {
      compatibilitySelectorConditions.push({ playableMouseKeyboard: true, playableMultiMouseKeyboard: false });
    }
    if (tagSearches.includes('support:MultiKeyboardMouse')) {
      compatibilitySelectorConditions.push({ playableMouseKeyboard: true, playableMultiMouseKeyboard: true });
    }

    const compatibilitySelectorCondition = compatibilitySelectorConditions.length
      ? { $and: compatibilitySelectorConditions }
      : {};
      
    const playerCountSelectorConditions = [];
    if (tagSearches.includes('players:2-4')) {
      playerCountSelectorConditions.push({ maxPlayers: { $gte: 2, $lte: 4 } });
    }
    if (tagSearches.includes('players:5-8')) {
      playerCountSelectorConditions.push({ maxPlayers: { $gte: 5, $lte: 8 } });
    }
    if (tagSearches.includes('players:9-plus')) {
      playerCountSelectorConditions.push({ maxPlayers: { $gte: 9 } });
    }
    const playerCountSelectorCondition = playerCountSelectorConditions.length
      ? { $or: playerCountSelectorConditions }
      : {};

    return Handlers.find(
      {
        ...searchInArraySelectorCondition,
        ...genreSelectorCondition,
        ...compatibilitySelectorCondition,
        ...playerCountSelectorCondition,
        gameName: { $regex: new RegExp(escapeRegExp(handlerTitleSearch)), $options: 'gi' },
        private: false,
        publicAuthorized: handlerOptionSearch !== 'unauthorized',
      },
      {
        sort: sortObject,
        limit: Math.min(isSearchFromArray ? safeLocalHandlerIds.length : limit, 600),
      },
    );
  },
  {
    url: 'api/v1/handlers/:0',
    httpMethod: 'get',
  },
);

Meteor.publish('handlers.mine', function handlersMine() {
  return Handlers.find(
    { owner: this.userId },
    {
      sort: { createdAt: -1 },
    },
  );
});
Meteor.publish('handlers.user', function handlersUser(userId) {
  return Handlers.find(
    { owner: userId, private: false, publicAuthorized: true },
    {
      sort: { createdAt: -1 },
    },
  );
});

// Note: documents.view is also used when editing an existing document.
Meteor.publish(
  'handlers.view',
  handlerId => {
    check(handlerId, String);
    return Handlers.find({ _id: handlerId });
  },
  {
    url: 'api/v1/handler/:0',
    httpMethod: 'get',
  },
);


/* This code is a PoC, its dirty */
const screenshotsCache = {};

WebApp.connectHandlers.use('/api/v1/screenshots', async (req, res, next) => {
  res.writeHead(200);
  const handlerId = req.url.split("/")[1];
  if(handlerId.length > 0){
    const handler = await Handlers.findOne({ _id: handlerId }, {fields: {gameId: 1}});
    if(!handler?.gameId) {
      res.end(JSON.stringify({error: 'Incorrect handlerId'}));
      return;
    }

    if(!screenshotsCache[handler.gameId]){
      const igdbApi = axios.create({
        baseURL: 'https://api.igdb.com/v4/',
        timeout: 2500,
        headers: {
          'Client-ID': Meteor.settings.private.IGDB_API_ID,
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'text/plain',
          Accept: 'application/json',
        },
      });
      const igdbAnswer = await igdbApi.post('screenshots', `fields *;where game = ${handler.gameId};`);
      screenshotsCache[handler.gameId] = igdbAnswer.data;
    }
    res.end(JSON.stringify({screenshots: screenshotsCache[handler.gameId]}));
  }else{
    res.end(JSON.stringify({error: 'No handler ID provided'}))
  }
  res.end(JSON.stringify({error: 'Unknown error'}))
})
/* End of dirty PoC */

WebApp.connectHandlers.use('/api/v1/hubstats', async (req, res, next) => {
  res.writeHead(200);
  let downloadsSum = 0;
  let hotnessSum = 0;
  let handlerCount = 0;
  let usersCount = 0;
  const allPackages = Packages.collection.find({}).fetch();
  allPackages.forEach(pkg => {
    if (pkg.meta.downloads > 0) {
      downloadsSum = downloadsSum + pkg.meta.downloads;
    }
  });
  const allHandlers = Handlers.find({ private: false }).fetch();
  allHandlers.forEach(hndl => {
    if (hndl.stars > 0) {
      hotnessSum = hotnessSum + hndl.stars;
    }
  });
  handlerCount = allHandlers.length;

  const allUsers = Meteor.users.find({}).fetch();
  usersCount = allUsers.length;

  const allComments = Comments.find({}).fetch();
  const commentsCount = allComments.length;

  res.end(
    `Total downloads: ${downloadsSum}` +
    `\nTotal hotness: ${hotnessSum}` +
    `\nTotal handlers: ${handlerCount}` +
    `\nTotal users: ${usersCount}` +
    `\nTotal comments ${commentsCount}`
  );
});

Meteor.publish('handlers.edit', function handlersEdit(documentId) {
  check(documentId, String);
  return Handlers.find({ _id: documentId, owner: this.userId });
});

Meteor.publish(
  'handlers.webdisplay',
  function handlers() {
    return Handlers.find(
      { private: false, publicAuthorized: true },
      {
        sort: { trendScore: -1 },
        limit: 15,
      },
    );
  },
  {
    url: 'api/v1/handlerswebdisplay',
    httpMethod: 'get',
  },
);

Meteor.publish(
  'handlers.full',
  function handlersFull() {
    return Handlers.find(
      {
        private: false, publicAuthorized: true
      },
      {
        sort: { stars: -1 },
        limit: 600,
      },
    );
  },
  {
    url: 'api/v1/allhandlers',
    httpMethod: 'get',
  },
);
